import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { approveDisplayedCurriculum, CurriculumPanel } from "../../src/features/creator/CurriculumPanel";
import { curriculum, ids, timestamp } from "../domain/fixtures";
import { curriculumDigest, type CurriculumApproval } from "../../src/domain/course";

describe("program review", () => {
  it("renders actual prerequisites, sequence, and the displayed revision for approval", () => {
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval onApprove={vi.fn()} />);
    expect(html).toContain("Basic algebra");
    expect(html).toContain("After: What fitting tells us");
    expect(html).toContain("Approve version 1");
    expect(html).not.toContain("expectedAnswer");
  });
  it("hides an approval operation if no actual handler is supplied", () => {
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval />);
    expect(html).not.toContain("Approve version");
  });
  it("does not submit approval for an older displayed revision", async () => {
    const approve = vi.fn();
    await expect(approveDisplayedCurriculum(curriculum(), () => ({ id: ids.draft, revision: 2 }), approve)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
  });
  it("checks the acknowledged digest and rejects a revision changed during approval", async () => {
    const draft = curriculum();
    let currentRevision = 1;
    const receipt: CurriculumApproval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(draft), approvedBy: ids.actor, approvedAt: timestamp };
    const approve = vi.fn(async () => { currentRevision = 2; return receipt; });
    await expect(approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: currentRevision }), approve)).rejects.toThrow("program changed");
    expect(approve).toHaveBeenCalledWith({ courseId: ids.course, draftId: ids.draft, revision: 1, contentDigest: receipt.contentDigest });
    await expect(approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: 1 }), async () => ({ ...receipt, contentDigest: "0".repeat(64) }))).rejects.toThrow();
  });
  it("accepts only a current matching acknowledgement", async () => {
    const draft = curriculum();
    const receipt: CurriculumApproval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(draft), approvedBy: ids.actor, approvedAt: timestamp };
    expect(await approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: 1 }), async () => receipt)).toEqual(receipt);
  });
});
