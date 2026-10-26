/** Illustrative goals for the landing scene. They show the kind of program Unfurl drafts; they are not saved courses. */
export interface HeroExample {
  topic: string;
  goal: string;
  title: string;
  chapters: readonly [string, string, string, string];
}

export const heroExamples: readonly HeroExample[] = [
  {
    topic: "artificial intelligence",
    goal: "I want to understand how machine learning works, then build AI systems myself.",
    title: "Understanding AI, from idea to application",
    chapters: ["Find your foundations", "Understand how models learn", "Build an AI system", "Make something of your own"],
  },
  {
    topic: "Japanese",
    goal: "I want to read manga in Japanese without reaching for a dictionary.",
    title: "Reading Japanese for real",
    chapters: ["Kana and the sounds behind them", "The kanji you will meet most", "Grammar patterns in dialogue", "Reading a full chapter"],
  },
  {
    topic: "astronomy",
    goal: "I want to understand what I am actually seeing through a small telescope.",
    title: "Reading the night sky",
    chapters: ["How the sky moves", "Light, distance and brightness", "Planets, stars and galaxies", "Planning your own observation"],
  },
  {
    topic: "music theory",
    goal: "I want to understand why the songs I love sound the way they do.",
    title: "Music theory through songs you know",
    chapters: ["Rhythm and meter", "Scales and keys", "Chords and progressions", "Analysing a song you choose"],
  },
  {
    topic: "photography",
    goal: "I want to take photos that look the way I imagined them.",
    title: "Photography from intention to image",
    chapters: ["Light and exposure", "Composition and framing", "Colour and editing", "A small series of your own"],
  },
  {
    topic: "economics",
    goal: "I want to understand inflation well enough to judge the news myself.",
    title: "Inflation, explained through evidence",
    chapters: ["Prices, money and measurement", "What drives inflation", "Central banks and interest rates", "Reading a news story critically"],
  },
  {
    topic: "chess",
    goal: "I want to stop drifting in the middlegame and play with a plan.",
    title: "Planning in the middlegame",
    chapters: ["Reading the position", "Pawn structures", "Active pieces and weaknesses", "Analysing your own games"],
  },
  {
    topic: "cooking",
    goal: "I want to cook without recipes by understanding what heat and salt do.",
    title: "Cooking by understanding",
    chapters: ["Heat and how food changes", "Salt, acid and fat", "Building a sauce", "Designing your own dish"],
  },
];
