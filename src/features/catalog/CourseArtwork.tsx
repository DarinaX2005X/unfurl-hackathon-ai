import { useId } from "react";

const motifs = new Set(["model-capacity", "model-capacity-v1", "mathematics", "language", "music", "science", "creative"]);
export function CourseArtwork({ motifId, alt, large = false }: { motifId: string; alt: string; large?: boolean }) {
  const id = useId().replaceAll(":", "");
  const motif = motifs.has(motifId) ? motifId : "learning-path";
  return <div className={`uf-course-art${large ? " uf-course-art--large" : ""}`}>
    <svg viewBox="0 0 420 270" role="img" aria-label={alt}>
      <defs><linearGradient id={`${id}-cover`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d77d60" /><stop offset="1" stopColor="#ac432f" /></linearGradient><linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fffefa" /><stop offset="1" stopColor="#d7d3c8" /></linearGradient></defs>
      <ellipse cx="216" cy="238" rx="115" ry="13" fill="#25272b" opacity=".09" />
      <g className="uf-course-art__book">
        <path d="M110 59 285 34Q301 32 305 48L332 209Q334 222 320 225L148 250Q132 251 130 235Z" fill="#823829" />
        <path d="m129 70 167-24 28 168-171 24q-13 1-15-12Z" fill={`url(#${id}-paper)`} />
        <path d="m145 228 172-25m-170 19 169-24m-169 18 168-23" stroke="#b5afa1" strokeWidth="1" />
        <g className="uf-course-art__cover">
          <path d="M102 49 280 24Q296 22 299 38l27 163-181 27q-17 2-20-16Z" fill={`url(#${id}-cover)`} />
          <path d="m113 48 24 164q2 10 10 11" fill="none" stroke="#823829" strokeWidth="2" opacity=".5" />
          <path d="m120 46 157-21q14-2 18 10" fill="none" stroke="#f7c8ad" strokeWidth="2" opacity=".6" />
          <g transform="translate(151 60) rotate(-8)" fill="none" stroke="#fff2df" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            {(motif === "model-capacity" || motif === "model-capacity-v1" || motif === "mathematics") ? <><path d="M5 103V12m0 91h120" opacity=".6" /><path d="M7 88C35 80 28 29 58 30s32 64 61 14" /><circle cx="33" cy="59" r="3" fill="#fff2df" /><circle cx="62" cy="34" r="3" fill="#fff2df" /><circle cx="91" cy="58" r="3" fill="#fff2df" /></> : motif === "music" ? <><path d="M16 38h110M16 56h110M16 74h110M16 92h110" opacity=".5" /><path d="M57 91V28l48-10v63M57 45l48-10" /><ellipse cx="47" cy="94" rx="10" ry="7" fill="#fff2df" /><ellipse cx="95" cy="84" rx="10" ry="7" fill="#fff2df" /></> : motif === "science" ? <><ellipse cx="65" cy="62" rx="58" ry="22" transform="rotate(34 65 62)" /><ellipse cx="65" cy="62" rx="58" ry="22" transform="rotate(-34 65 62)" /><circle cx="65" cy="62" r="8" fill="#fff2df" /></> : motif === "language" ? <><path d="M12 18h90v53H58L30 93V71H12Z" /><path d="M37 40h38M37 54h22" /><path d="M82 87h29V56" opacity=".6" /></> : motif === "creative" ? <><path d="m15 105 15-39 67-53 20 24-68 53Z" /><path d="m30 66 19 24M89 20l20 24M15 105l24-7" /><path d="M62 113h61" opacity=".6" /></> : <><path d="M20 106C-4 68 91 95 88 54S36 56 37 16" /><circle cx="20" cy="106" r="8" fill="#fff2df" /><circle cx="37" cy="16" r="8" fill="#fff2df" /><circle cx="88" cy="54" r="8" fill="#fff2df" /></>}
          </g>
        </g>
      </g>
    </svg>
  </div>;
}

export function EmptyBookArtwork() {
  return <svg className="uf-empty-book" viewBox="0 0 420 280" aria-hidden="true">
    <ellipse cx="213" cy="236" rx="148" ry="15" fill="#25272b" opacity=".07" />
    <path d="m60 91 143 25 156-29-10 142-144 21L68 223Z" fill="#b54c35" />
    <path d="m69 83 134 26 148-29-8 137-139 24-128-28Z" fill="#d7d3c8" />
    <path d="m77 71 128 30 136-31-6 137-130 24-121-28Z" fill="#fffefa" />
    <path d="M205 101v130M77 71q78-10 128 30 54-45 136-31" fill="none" stroke="#c9c4b9" strokeWidth="2" />
    <path d="m91 84 3 107q62 0 104 29M328 82l-5 116q-64 3-111 23" fill="none" stroke="#eceae3" strokeWidth="3" />
    <path d="m250 90-4 78 12-8 11 4 4-78" fill="#ba432d" />
    <path d="M205 101q-13 63 0 130" fill="none" stroke="#e1dbce" strokeWidth="6" opacity=".65" />
  </svg>;
}
