"use client";

import { useId } from "react";
import { useMotionVisibility } from "./useMotionVisibility";

/** Original pop-up book: every raised paper surface meets the same open spine. */
export function BookScene() {
  const id = useId().replaceAll(":", "");
  const { ref, active, started } = useMotionVisibility<HTMLDivElement>();
  const fill = (name: string) => `url(#${id}-${name})`;
  return <div ref={ref} className="landing-book" data-started={started} data-running={active}>
    <svg className="landing-book__drawing" viewBox="0 0 1200 520" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>A course unfolding into practice</title>
      <desc id={`${id}-description`}>A substantial open book with layered paper, a branching idea, and a model rising from its pages. A folded path joins the two sides.</desc>
      <defs>
        <linearGradient id={`${id}-cover`} x1="0" y1="0" x2=".5" y2="1"><stop stopColor="#DD8769" /><stop offset=".6" stopColor="#BB4E33" /><stop offset="1" stopColor="#973A27" /></linearGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#E9E1D0" /><stop offset=".45" stopColor="#D8CDB8" /><stop offset="1" stopColor="#B5A68C" /></linearGradient>
        <linearGradient id={`${id}-left`} x1="0" y1="0" x2="1" y2=".2"><stop stopColor="#FFFEF8" /><stop offset=".6" stopColor="#F1EBDD" /><stop offset=".9" stopColor="#D0C4AD" /><stop offset="1" stopColor="#9E8D71" /></linearGradient>
        <linearGradient id={`${id}-right`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#A9997B" /><stop offset=".17" stopColor="#E7DECA" /><stop offset=".48" stopColor="#FFFEF7" /><stop offset="1" stopColor="#F2ECDE" /></linearGradient>
        <linearGradient id={`${id}-leaf`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#FFFEFA" /><stop offset=".6" stopColor="#F8F3E7" /><stop offset="1" stopColor="#DED2B9" /></linearGradient>
        <linearGradient id={`${id}-back`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#DED2B9" /><stop offset="1" stopColor="#A99A7E" /></linearGradient>
        <linearGradient id={`${id}-ribbon`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#D77A59" /><stop offset="1" stopColor="#B44D31" /></linearGradient>
        <radialGradient id={`${id}-floor`}><stop stopColor="#897052" stopOpacity=".22" /><stop offset="1" stopColor="#897052" stopOpacity="0" /></radialGradient>
        <filter id={`${id}-soft`} x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="12" /></filter>
        <filter id={`${id}-contact`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <ellipse cx="610" cy="437" rx="568" ry="76" fill={fill("floor")} />
      <path d="m121 370 470 82 508-96-39 62-452 68-468-75Z" fill="#796449" opacity=".16" filter={fill("soft")} />
      <g className="landing-book__cover">
        <path d="M92 304 558 342 1032 272 1122 367 1120 389 604 476 92 393Z" fill="#843623" />
        <path d="M92 296 558 334 1032 264 1122 367 604 455 92 374Z" fill={fill("cover")} stroke="#A9442D" strokeWidth="2" />
        <path d="m101 376 500 79 511-87" fill="none" stroke="#E7A68C" strokeWidth="2" />
        <path d="m559 335 42 120 16 13 4-126" fill="#8A3827" opacity=".7" />
        <path d="m650 433 28-5 17 69-17-9-13 17Z" fill={fill("ribbon")} /><path d="m654 435 13 56" fill="none" stroke="#E49B7F" strokeWidth="2" />
      </g>
      <g className="landing-book__pages">
        <path d="M117 291C266 272 425 297 566 330 701 270 872 252 1025 268L1098 350 1094 379 600 444 116 368Z" fill={fill("edge")} stroke="#C2B397" />
        <path d="M119 333 599 417 1095 357M118 340 599 423 1095 363M118 347 599 430 1094 368M118 356 599 437 1094 374" fill="none" stroke="#9E8E73" opacity=".52" />
        <path d="M118 324 598 410 1098 350" fill="none" stroke="#FFFCF0" strokeWidth="2" />
        <path d="M126 281C278 257 443 287 567 328L600 424C441 365 278 351 117 347Z" fill={fill("left")} />
        <path d="M567 328C706 256 867 244 1025 263L1098 350C929 337 756 369 600 424Z" fill={fill("right")} />
      </g>
      <g className="landing-book__left-leaf">
        <path d="M153 244C300 219 452 263 564 305L599 418C441 357 274 341 117 341Z" fill={fill("left")} stroke="#DCD2BE" />
        <path d="M160 223C300 206 446 241 560 290L599 414C437 348 288 330 124 330Z" fill={fill("left")} stroke="#DAD0BA" />
        <path d="M169 203C307 192 447 228 555 273L599 409C441 339 287 318 130 320Z" fill={fill("left")} stroke="#E4DCCB" />
        <path d="M169 203C319 198 444 230 555 273" fill="none" stroke="#FFFEFA" strokeWidth="3" />
        <path d="m176 290 158 24m-161-12 120 19" fill="none" stroke="#BAAD95" strokeWidth="2" />
      </g>
      <g className="landing-book__right-leaf">
        <path d="M555 273C716 200 879 197 1014 218L1098 345C925 329 762 359 599 409Z" fill={fill("right")} stroke="#DED4BE" />
        <path d="M555 273C710 201 880 200 1014 218" stroke="#FFFEFA" strokeWidth="3" fill="none" />
        <path d="m942 322 78-10m-64 21 79-10" stroke="#CFC2A7" strokeWidth="2" />
      </g>
      <g className="landing-book__insert-shadow"><path d="m287 277 245 72 65-32-198-93Z" fill="#69583D" opacity=".18" filter={fill("contact")} /><path d="m692 286 257 46 94-42-255-56Z" fill="#69583D" opacity=".17" filter={fill("contact")} /></g>
      <g className="landing-book__structure"><g className="landing-book__structure-paper">
        <path d="M283 77 265 90 231 277 258 298 478 336 509 141Z" fill={fill("back")} />
        <path d="M296 69C366 67 437 91 510 125L479 326C406 295 332 275 258 287Z" fill="#E0D5BD" stroke="#BCAE92" />
        <path d="M309 58C380 57 448 80 521 116L482 317C414 282 337 266 267 276Z" fill={fill("leaf")} stroke="#C9BCA1" />
        <path d="M309 58C383 62 448 82 521 116" fill="none" stroke="#FFFEFA" strokeWidth="4" />
        <path d="m314 59-14 68 31-7Z" fill="#F1E9D8" /><path d="m300 127 31-7-17-61" fill="none" stroke="#D8CCB3" />
        <g transform="matrix(1 .23 -.2 1 329 126)"><path d="M30 42v30h65v34M95 73h58V43" stroke="#B4A58B" strokeWidth="4" fill="none" /><rect x="4" y="7" width="55" height="43" rx="10" fill="#CB6B4C" /><path d="m22 26 8 8 14-17" stroke="#FFF6E6" strokeWidth="3" fill="none" strokeLinecap="round" /><rect x="126" y="7" width="55" height="43" rx="10" fill="#E5CFB3" stroke="#BBA080" /><path d="M141 23h24m-24 10h16" stroke="#976D4B" strokeWidth="3" strokeLinecap="round" /><rect x="68" y="103" width="55" height="43" rx="10" fill="#95A084" /><path d="m81 125 14-10 14 10-14 10Z" fill="none" stroke="#F4F0DD" strokeWidth="3" /></g>
        <path d="M267 276C339 266 416 285 482 317L523 330C440 294 350 280 284 292Z" fill="#D7C9AD" />
      </g></g>
      <g className="landing-book__model"><g className="landing-book__model-paper">
        <path d="M661 46 689 27 929 73 987 267 958 285 711 243Z" fill={fill("back")} />
        <path d="M661 46 891 86 958 285 711 243Z" fill={fill("leaf")} stroke="#CBBDA0" />
        <path d="m891 86 38-13 58 194-29 18Z" fill="#C8BA9C" /><path d="m661 46 230 40" stroke="#FFFEFA" strokeWidth="4" />
        <path d="m661 46 30 57 43-43Z" fill="#EEE4CE" /><path d="m691 103 43-43" stroke="#CFC1A3" />
        <g transform="matrix(1 .17 .28 1 705 107)"><path d="M5 24v115h174" fill="none" stroke="#B4A78B" strokeWidth="2" /><path d="M5 83h174" stroke="#D8CDB4" strokeDasharray="4 7" /><path d="M13 113C43 130 40 44 76 54S131 131 170 31" fill="none" stroke="#BA5033" strokeWidth="5" strokeLinecap="round" /><g fill="#FFFCF0" stroke="#677356" strokeWidth="3"><circle cx="18" cy="108" r="6" /><circle cx="49" cy="72" r="6" /><circle cx="78" cy="52" r="6" /><circle cx="113" cy="87" r="6" /><circle cx="143" cy="85" r="6" /><circle cx="168" cy="37" r="6" /></g></g>
        <path d="m711 243 247 42 46-14-249-43Z" fill="#D8CAAC" />
      </g></g>
      <g className="landing-book__connections">
        <path d="m486 323 57-30 57 17 58-43 54 18 45-29 23 23-66 43-49-15-55 43-58-18-45 24Z" fill="#B8A88B" opacity=".26" transform="translate(5 10)" />
        <path d="m486 317 57-30 57 17 58-43 54 18 45-29 23 23-66 43-49-15-55 43-58-18-45 24Z" fill="#EBDCC0" stroke="#C0AE8D" />
        <path d="m543 287 9 39 58 18-10-40Zm115-26 7 40 49 15-2-37Z" fill="#D4C09B" />
        <path d="m486 317 57-30 57 17 58-43" fill="none" stroke="#FFFAE9" strokeWidth="2" />
      </g>
    </svg>
  </div>;
}
