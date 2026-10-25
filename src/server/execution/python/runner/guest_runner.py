import ctypes
import errno
import json
import math
import os
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

CPU_SECONDS = 2
WALL_SECONDS = 3.0
MEMORY_BYTES = 256 * 1024 * 1024
OUTPUT_BYTES = 64 * 1024
RESULT_BYTES = 16 * 1024
ENVELOPE_BYTES = 96 * 1024
SCRATCH_BYTES = 1024 * 1024
LEARNER_UID = 60001
LEARNER_GID = 60001


def emit(value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > ENVELOPE_BYTES:
        data = json.dumps({"status": "error", "code": "invalid_result", "message": "Runner result exceeded limit"}, separators=(",", ":")).encode()
    os.write(1, data + b"\n")


def run_checked(args):
    completed = subprocess.run(args, capture_output=True, timeout=3)
    if completed.returncode != 0:
        raise RuntimeError(f"trusted setup failed: {args[0]} exit {completed.returncode}")


def mount_read_only(source, target, recursive=False):
    os.makedirs(target, exist_ok=True)
    run_checked(["mount", "--rbind" if recursive else "--bind", source, target])
    run_checked(["mount", "-o", "remount,bind,ro,nosuid,nodev", target])


def prepare_root():
    root = tempfile.mkdtemp(prefix="unfurl-py-root-")
    for relative in ("usr", "tmp", "dev"):
        os.makedirs(os.path.join(root, relative), exist_ok=True)
    mount_read_only("/usr", os.path.join(root, "usr"), recursive=True)
    for link_name, target in (("lib", "usr/lib"), ("lib64", "usr/lib64")):
        destination = os.path.join(root, link_name)
        if not os.path.lexists(destination):
            os.symlink(target, destination)
    scratch = os.path.join(root, "tmp")
    run_checked([
        "mount", "-t", "tmpfs", "-o",
        f"size={SCRATCH_BYTES},nr_inodes=128,mode=0700,uid={LEARNER_UID},gid={LEARNER_GID},nosuid,nodev,noexec",
        "tmpfs", scratch,
    ])
    for device in ("null", "urandom"):
        destination = os.path.join(root, "dev", device)
        open(destination, "ab").close()
        run_checked(["mount", "--bind", f"/dev/{device}", destination])
        run_checked(["mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", destination])
    os.chmod(root, 0o555)
    return root


def cleanup_root(root):
    for target in ("dev/urandom", "dev/null", "tmp", "usr"):
        subprocess.run(["umount", "-l", os.path.join(root, target)], capture_output=True, timeout=2)
    shutil.rmtree(root, ignore_errors=True)


def create_cgroup(case_id):
    base = "/sys/fs/cgroup"
    name = "unfurl-proof-" + "".join(ch for ch in case_id if ch.isalnum() or ch in "-_")[:32] + "-" + uuid.uuid4().hex[:8]
    group = os.path.join(base, name)
    os.mkdir(group)
    limits = {
        "pids.max": "1",
        "memory.max": str(MEMORY_BYTES),
        "memory.swap.max": "0",
        "cpu.max": "100000 100000",
    }
    applied = {}
    for filename, value in limits.items():
        target = os.path.join(group, filename)
        try:
            with open(target, "w", encoding="ascii") as handle:
                handle.write(value)
            with open(target, encoding="ascii") as handle:
                applied[filename] = handle.read().strip()
        except OSError as error:
            applied[filename] = f"error:{error.errno}"
    return group, applied


def cleanup_cgroup(group):
    try:
        for _ in range(20):
            try:
                os.rmdir(group)
                return True
            except OSError as error:
                if error.errno not in {errno.EBUSY, errno.ENOTEMPTY}:
                    break
                time.sleep(0.025)
    except Exception:
        pass
    return False


class SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


def install_seccomp():
    libc = ctypes.CDLL(None, use_errno=True)
    BPF_LD_W_ABS = 0x20
    BPF_JMP_JEQ_K = 0x15
    BPF_RET_K = 0x06
    ALLOW = 0x7FFF0000
    KILL = 0x80000000
    ERRNO = 0x00050000
    AUDIT_ARCH_X86_64 = 0xC000003E
    blocked = {
        41: errno.ENETUNREACH,   # socket
        42: errno.ENETUNREACH,   # connect
        43: errno.ENETUNREACH,   # accept
        49: errno.ENETUNREACH,   # bind
        50: errno.ENETUNREACH,   # listen
        53: errno.ENETUNREACH,   # socketpair
        56: errno.EUSERS,        # clone
        57: errno.EUSERS,        # fork
        58: errno.EUSERS,        # vfork
        59: errno.EACCES,        # execve
        101: errno.EPERM,        # ptrace
        155: errno.EPERM,        # pivot_root
        161: errno.EPERM,        # chroot
        165: errno.EPERM,        # mount
        166: errno.EPERM,        # umount2
        167: errno.EPERM,        # swapon
        168: errno.EPERM,        # swapoff
        169: errno.EPERM,        # reboot
        175: errno.EPERM,        # init_module
        176: errno.EPERM,        # delete_module
        246: errno.EPERM,        # kexec_load
        250: errno.EPERM,        # keyctl
        272: errno.EPERM,        # unshare
        298: errno.EPERM,        # perf_event_open
        304: errno.EPERM,        # open_by_handle_at
        308: errno.EPERM,        # setns
        313: errno.EPERM,        # finit_module
        321: errno.EPERM,        # bpf
        322: errno.EACCES,       # execveat
        323: errno.EPERM,        # userfaultfd
        425: errno.EPERM,        # io_uring_setup
        435: errno.EUSERS,       # clone3
    }
    rules = [SockFilter(BPF_LD_W_ABS, 0, 0, 4)]
    rules.extend([
        SockFilter(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
        SockFilter(BPF_RET_K, 0, 0, KILL),
        SockFilter(BPF_LD_W_ABS, 0, 0, 0),
    ])
    for number, error_number in sorted(blocked.items()):
        rules.append(SockFilter(BPF_JMP_JEQ_K, 0, 1, number))
        rules.append(SockFilter(BPF_RET_K, 0, 0, ERRNO | error_number))
    rules.append(SockFilter(BPF_RET_K, 0, 0, ALLOW))
    array = (SockFilter * len(rules))(*rules)
    program = SockFprog(len(rules), array)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_SECCOMP failed")
    return libc.prctl(39, 0, 0, 0, 0) == 1


def validate_json_value(value):
    nodes = 0

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 2048 or depth > 12:
            raise ValueError("result shape limit exceeded")
        if item is None or type(item) is bool or type(item) is str:
            return
        if type(item) is int:
            if abs(item) > 2**53 - 1:
                raise ValueError("integer is outside interoperable JSON range")
            return
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError("non-finite number")
            return
        if type(item) is list:
            for child in item:
                visit(child, depth + 1)
            return
        if type(item) is dict:
            for key, child in item.items():
                if type(key) is not str or key in {"__proto__", "prototype", "constructor"}:
                    raise ValueError("invalid object key")
                visit(child, depth + 1)
            return
        raise ValueError("result is not plain JSON data")

    visit(value, 0)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > RESULT_BYTES:
        raise ValueError("encoded result exceeds 16 KiB")
    return encoded, nodes


def child_main(root, code, payload, result_fd, stdout_fd, stderr_fd, sync_fd):
    try:
        os.read(sync_fd, 1)
        os.close(sync_fd)
        os.dup2(stdout_fd, 1)
        os.dup2(stderr_fd, 2)
        for fd in (stdout_fd, stderr_fd):
            if fd not in (1, 2):
                os.close(fd)
        os.chroot(root)
        os.chdir("/tmp")
        os.setgroups([])
        os.setgid(LEARNER_GID)
        os.setuid(LEARNER_UID)
        os.umask(0o077)
        os.environ.clear()
        os.environ.update({"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "PYTHONHASHSEED": "0"})
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (SCRATCH_BYTES, SCRATCH_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        no_new_privs = install_seccomp()
        namespace = {"__name__": "learner_submission", "__builtins__": __builtins__}
        exec(code, namespace, namespace)
        solve = namespace.get("solve")
        if not callable(solve):
            raise ValueError("solve(payload) is required")
        value = solve(payload)
        encoded, nodes = validate_json_value(value)
        message = {
            "status": "ok",
            "value": json.loads(encoded),
            "resultBytes": len(encoded),
            "nodes": nodes,
            "isolation": {
                "uid": os.getuid(),
                "gid": os.getgid(),
                "groups": os.getgroups(),
                "noNewPrivs": no_new_privs,
                "cwd": os.getcwd(),
                "envKeys": sorted(os.environ),
            },
        }
    except MemoryError:
        message = {"status": "error", "code": "memory_limit", "message": "Memory limit exceeded"}
    except OSError as error:
        if error.errno in {errno.ENOSPC, errno.EDQUOT, errno.EFBIG}:
            code_name = "file_limit"
        elif error.errno in {errno.EUSERS, errno.EAGAIN, errno.EACCES}:
            code_name = "process_limit"
        else:
            code_name = "runtime_error"
        message = {"status": "error", "code": code_name, "message": f"{type(error).__name__}: operation failed ({error.errno})"}
    except ValueError as error:
        message = {"status": "error", "code": "invalid_result", "message": str(error)[:256]}
    except BaseException as error:
        message = {"status": "error", "code": "runtime_error", "message": f"{type(error).__name__}: {str(error)[:200]}"}
    try:
        data = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(data) > RESULT_BYTES:
            data = b'{"status":"error","code":"invalid_result","message":"Result envelope exceeded limit"}'
        os.write(result_fd, data)
    finally:
        os._exit(0)


def supervise(root, code, payload, case_id):
    result_r, result_w = os.pipe()
    stdout_r, stdout_w = os.pipe()
    stderr_r, stderr_w = os.pipe()
    sync_r, sync_w = os.pipe()
    group, cgroup_limits = create_cgroup(case_id)
    started = time.monotonic()
    pid = os.fork()
    if pid == 0:
        for fd in (result_r, stdout_r, stderr_r, sync_w):
            os.close(fd)
        child_main(root, code, payload, result_w, stdout_w, stderr_w, sync_r)
    for fd in (result_w, stdout_w, stderr_w, sync_r):
        os.close(fd)
    try:
        with open(os.path.join(group, "cgroup.procs"), "w", encoding="ascii") as handle:
            handle.write(str(pid))
        os.write(sync_w, b"1")
    finally:
        os.close(sync_w)
    selector = selectors.DefaultSelector()
    streams = {stdout_r: "stdout", stderr_r: "stderr", result_r: "result"}
    for fd, label in streams.items():
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ, label)
    buffers = {"stdout": bytearray(), "stderr": bytearray(), "result": bytearray()}
    terminal = None
    wait_status = None
    while selector.get_map() or wait_status is None:
        elapsed = time.monotonic() - started
        if terminal is None and elapsed > WALL_SECONDS:
            terminal = "time_limit"
            os.kill(pid, signal.SIGKILL)
        for key, _ in selector.select(timeout=0.02):
            try:
                chunk = os.read(key.fd, 8192)
            except BlockingIOError:
                continue
            if not chunk:
                selector.unregister(key.fd)
                os.close(key.fd)
                continue
            label = key.data
            if label in {"stdout", "stderr"}:
                current = len(buffers["stdout"]) + len(buffers["stderr"])
                remaining = max(0, OUTPUT_BYTES - current)
                buffers[label].extend(chunk[:remaining])
                if terminal is None and len(chunk) > remaining:
                    terminal = "output_limit"
                    os.kill(pid, signal.SIGKILL)
            else:
                buffers[label].extend(chunk[: RESULT_BYTES + 1 - len(buffers[label])])
                if terminal is None and len(buffers[label]) > RESULT_BYTES:
                    terminal = "invalid_result"
                    os.kill(pid, signal.SIGKILL)
        if wait_status is None:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                wait_status = status
    duration_ms = round((time.monotonic() - started) * 1000)
    if terminal is None and wait_status is not None and os.WIFSIGNALED(wait_status):
        terminal = "time_limit" if os.WTERMSIG(wait_status) in {signal.SIGKILL, signal.SIGXCPU} else "runtime_error"
    cgroup_cleanup = cleanup_cgroup(group)
    if terminal:
        result = {"status": "error", "code": terminal, "message": {
            "time_limit": "Execution time limit exceeded",
            "output_limit": "Combined output limit exceeded",
            "invalid_result": "Result channel exceeded limit",
            "runtime_error": "Learner process terminated",
        }[terminal]}
    else:
        try:
            result = json.loads(buffers["result"])
        except Exception:
            result = {"status": "error", "code": "invalid_result", "message": "Missing or invalid result envelope"}
    if result.get("status") == "ok":
        result["stdout"] = buffers["stdout"].decode("utf-8", "replace")
    result["audit"] = {
        "durationMs": duration_ms,
        "stdoutBytes": len(buffers["stdout"]),
        "stderrBytes": len(buffers["stderr"]),
        "combinedOutputBytes": len(buffers["stdout"]) + len(buffers["stderr"]),
        "cgroup": cgroup_limits,
        "cgroupRemoved": cgroup_cleanup,
        "scratchBytes": SCRATCH_BYTES,
        "cpuSeconds": CPU_SECONDS,
        "wallSeconds": WALL_SECONDS,
        "memoryBytes": MEMORY_BYTES,
    }
    return result


def main():
    if len(sys.argv) != 4:
        emit({"status": "error", "code": "invalid_result", "message": "Runner arguments invalid"})
        return
    source_path, input_path, case_id = sys.argv[1:]
    source = open(source_path, encoding="utf-8").read()
    payload = json.load(open(input_path, encoding="utf-8"))
    try:
        code = compile(source, "<learner>", "exec", dont_inherit=True, optimize=0)
    except SyntaxError as error:
        emit({
            "status": "error",
            "code": "syntax_error",
            "message": "Syntax error",
            "line": error.lineno,
            "column": error.offset,
            "audit": {"durationMs": 0, "stdoutBytes": 0, "stderrBytes": 0, "combinedOutputBytes": 0},
        })
        return
    source = None
    root = prepare_root()
    try:
        result = supervise(root, code, payload, case_id)
    finally:
        cleanup_root(root)
    emit(result)


if __name__ == "__main__":
    main()
