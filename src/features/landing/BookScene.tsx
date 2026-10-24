"use client";

import { useId } from "react";
import { useMotionVisibility } from "./useMotionVisibility";

/** Original paper geometry. The raised leaves remain joined to the open book. */
export function BookScene() {
  const id = useId().replaceAll(":", "");
  const { ref, active, started } = useMotionVisibility<HTMLDivElement>();
  const fill = (name: string) => `url(#${id}-${name})`;

  return <div ref={ref} className="landing-book" data-started={started} data-running={active}>
    <svg className="landing-book__drawing" viewBox="0 0 1200 480" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>A course unfolding into practice</title>
      <desc id={`${id}-description`}>An open book with a connected sequence of ideas on one paper leaf and a model to explore on another. Both unfold from the same book.</desc>
      <defs>
        <linearGradient id={`${id}-cover`} x1="0" y1="0" x2="0.8" y2="1">
          <stop stopColor="#D1684D" /><stop offset=".5" stopColor="#BC4B34" /><stop offset="1" stopColor="#A43D2C" />
        </linearGradient>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2=".85" y2="1">
          <stop stopColor="#FFFEF9" /><stop offset=".6" stopColor="#F3EFE4" /><stop offset="1" stopColor="#D4CDBE" />
        </linearGradient>
        <linearGradient id={`${id}-left-page`} x1="0" y1="0" x2="1" y2=".3">
          <stop stopColor="#FFFEF9" /><stop offset=".7" stopColor="#F3F0E6" /><stop offset="1" stopColor="#C5BEAD" />
        </linearGradient>
        <linearGradient id={`${id}-right-page`} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#BEB6A5" /><stop offset=".14" stopColor="#ECE8DA" /><stop offset=".45" stopColor="#FFFEF8" /><stop offset="1" stopColor="#F5F2E8" />
        </linearGradient>
        <linearGradient id={`${id}-leaf`} x1="0" y1="0" x2=".6" y2="1">
          <stop stopColor="#FFFEFA" /><stop offset=".8" stopColor="#F4F0E5" /><stop offset="1" stopColor="#D9D2C1" />
        </linearGradient>
        <linearGradient id={`${id}-fold`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#DDD5C3" /><stop offset="1" stopColor="#B5AB96" />
        </linearGradient>
        <radialGradient id={`${id}-floor`}><stop stopColor="#B5A58F" stopOpacity=".26" /><stop offset="1" stopColor="#B5A58F" stopOpacity="0" /></radialGradient>
        <filter id={`${id}-soft`} x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="12" /></filter>
        <filter id={`${id}-contact`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>

      <ellipse cx="607" cy="390" rx="557" ry="87" fill={fill("floor")} />
      <path d="M141 333 572 407 1088 338 1045 382 601 451 174 377Z" fill="#635747" opacity=".13" filter={fill("soft")} />
      <path d="m169 345 423 68 468-65" fill="none" stroke="#5D4D3D" strokeWidth="13" opacity=".23" filter={fill("contact")} />

      <g className="landing-book__cover">
        <path d="M130 287 569 337 1014 260 1086 337 1086 351 595 432 128 357Z" fill="#873624" />
        <path d="M130 279 569 328 1014 252 1086 337 595 418 128 344Z" fill={fill("cover")} stroke="#AE472F" strokeWidth="2" />
        <path d="M139 342 594 415 1075 337" fill="none" stroke="#DE927B" strokeWidth="2" opacity=".8" />
        <path d="m576 327 19 91 11 9 5-94" fill="#913A28" opacity=".6" />
        <path d="m616 398 25-4 9 56-15-6-12 10Z" fill="#B84932" />
        <path d="m619 400 4 45" stroke="#E28B70" strokeWidth="2" />
      </g>

      <g className="landing-book__pages">
        <path d="M151 273 565 318 1000 246 1065 321 1064 339 590 405 150 333Z" fill="#D8D1C1" stroke="#C7BEAC" />
        <path d="M151 282 566 328 1065 313M151 292 567 339 1065 322M152 302 570 350 1065 330M152 313 579 371 1064 338M152 323 590 395 1064 338" fill="none" stroke="#AAA18F" strokeWidth="1" opacity=".48" />
        <path d="M154 273C290 259 438 292 565 318 692 263 839 238 1000 246L1065 321C855 318 726 351 590 393 438 344 293 328 153 326Z" fill={fill("paper")} />
      </g>

      <g className="landing-book__left-leaf">
        <path d="M169 234C301 216 435 239 566 285L590 387C452 334 296 325 153 321Z" fill={fill("left-page")} stroke="#E2DDCF" />
        <path d="M171 235C324 230 453 260 566 285" fill="none" stroke="#FFFEFA" strokeWidth="3" />
        <path d="M566 285 590 386" stroke="#9B927F" strokeWidth="2" opacity=".45" />
        <path d="m203 293 139 20m-144-9 103 16" stroke="#C9C1B0" strokeWidth="2" />
      </g>
      <g className="landing-book__right-leaf">
        <path d="M566 285C690 226 833 215 997 225L1065 321C875 310 736 339 590 387Z" fill={fill("right-page")} stroke="#DED8C8" />
        <path d="M566 285C696 229 838 217 997 226" fill="none" stroke="#FFFEFA" strokeWidth="3" />
        <path d="m864 321 104-10m-89 17 104-10" stroke="#D0C8B8" strokeWidth="2" />
      </g>

      <g className="landing-book__insert-shadow">
        <path d="m284 265 228 61 69-26-174-79Z" fill="#6E624D" opacity=".16" filter={fill("contact")} />
        <path d="m716 276 202 41 82-42-210-36Z" fill="#6E624D" opacity=".17" filter={fill("contact")} />
      </g>

      <g className="landing-book__structure">
        <path d="m281 134-17 12-28 134 17 15 208 35 28-142Z" fill={fill("fold")} />
        <path d="m281 134 208 38-28 151-208-35Z" fill={fill("leaf")} stroke="#D6CEBB" />
        <path d="m281 134 208 38" stroke="#FFFEFA" strokeWidth="3" />
        <path d="m282 135-28 152" stroke="#EAE3D3" strokeWidth="2" />
        <g transform="matrix(1 .18 -.18 1 299 170)">
          <path d="M0 0h95M0 8h65" stroke="#4B4D47" strokeWidth="3" strokeLinecap="round" />
          <path d="M17 49v25h60v27" stroke="#AB9F88" strokeWidth="3" fill="none" />
          <path d="M77 74h57V49" stroke="#AB9F88" strokeWidth="3" fill="none" />
          <rect x="0" y="29" width="37" height="30" rx="6" fill="#CA694F" />
          <rect x="114" y="29" width="37" height="30" rx="6" fill="#E8C9B8" stroke="#C79D85" />
          <rect x="59" y="92" width="37" height="30" rx="6" fill="#A6ADA0" />
          <path d="m11 43 5 5 10-10" stroke="#FFFEF9" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M126 40h14m-14 7h9" stroke="#8E634D" strokeWidth="2" strokeLinecap="round" />
          <path d="m69 107 8-7 8 7-8 7Z" fill="none" stroke="#495B4C" strokeWidth="2" />
        </g>
        <path d="m253 288 208 35 35-19-207-35Z" fill="#E4DCCD" opacity=".72" />
      </g>

      <g className="landing-book__model">
        <path d="m678 82 27-15 187 29 45 167-26 16-198-32Z" fill={fill("fold")} />
        <path d="m678 82 188 29 45 168-198-32Z" fill={fill("leaf")} stroke="#D3CBB8" />
        <path d="m678 82 188 29" stroke="#FFFEFA" strokeWidth="3" />
        <path d="m866 111 26-15 45 167-26 16Z" fill="#CFC6B1" />
        <g transform="matrix(1 .155 .22 1 707 120)">
          <path d="M0 3h89M0 11h57" stroke="#4B4D47" strokeWidth="3" strokeLinecap="round" />
          <path d="M2 35v83h147" stroke="#B4AC99" strokeWidth="1.5" fill="none" />
          <path d="M4 97C31 111 40 37 73 53S111 103 144 29" fill="none" stroke="#BA432D" strokeWidth="4" strokeLinecap="round" />
          <g fill="#FFFEFA" stroke="#515D50" strokeWidth="2.5">
            <circle cx="13" cy="99" r="4.5" /><circle cx="38" cy="68" r="4.5" /><circle cx="65" cy="48" r="4.5" /><circle cx="93" cy="76" r="4.5" /><circle cx="119" cy="69" r="4.5" /><circle cx="140" cy="32" r="4.5" />
          </g>
        </g>
        <path d="m713 247 198 32 40-11-196-34Z" fill="#E8E0D0" opacity=".8" />
      </g>

      <g className="landing-book__connections">
        <path d="m510 302 48 9 26-21-47-9Z" fill="#D8886D" stroke="#B3664D" />
        <path d="m510 302 1 12 47 9 0-12Z" fill="#A6553E" /><path d="m558 311 26-21 0 12-26 21Z" fill="#BE7058" />
        <path d="m574 280 48 8 25-21-47-8Z" fill="#E5D5B7" stroke="#BCAA89" />
        <path d="m574 280 1 12 47 8 0-12Z" fill="#BFAE8D" /><path d="m622 288 25-21 0 12-25 21Z" fill="#CFC09F" />
        <path d="m620 324 48 8 25-21-47-8Z" fill="#A0AA98" stroke="#7C8A72" />
        <path d="m620 324 1 12 47 8 0-12Z" fill="#77856B" /><path d="m668 332 25-21 0 12-25 21Z" fill="#89967E" />
      </g>
    </svg>
  </div>;
}
