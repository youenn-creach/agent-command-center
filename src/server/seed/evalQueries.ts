/** Kept apart from the corpus: the dashboard imports these sample questions, and the corpus stays server-side. */

/** Evaluation set: paraphrased questions and the document that should answer them. */
export const EVAL_QUERIES: { query: string; expected: string; filters?: { sourceType?: string; tags?: string[] } }[] = [
  { query: "When is my bicycle getting repaired?", expected: "demo_bike" },
  { query: "Where am I staying in Portugal?", expected: "demo_lisbon" },
  { query: "How much money can I spend redoing the cooking area?", expected: "demo_kitchen" },
  { query: "Which day of the week is my longest training run?", expected: "demo_running" },
  { query: "How often do I feed the bread culture?", expected: "demo_sourdough" },
  { query: "What receipts do I need for my tax return?", expected: "demo_tax" },
  { query: "What did I learn about feedback loops?", expected: "demo_systems" },
  { query: "What microcontroller is the balcony herb monitor using?", expected: "demo_plants" },
  { query: "Who handles composting first?", expected: "demo_garden" },
  { query: "When does my vehicle cover expire?", expected: "demo_insurance" },
  { query: "What present should I get my mother?", expected: "demo_gifts" },
  { query: "When is my language conversation practice?", expected: "demo_spanish" },
  { query: "Which neighbourhood is my guesthouse in?", expected: "demo_lisbon" },
  { query: "Which contractor quote includes relocating the sink?", expected: "demo_kitchen" },
  { query: "What finishing time am I aiming for in the race?", expected: "demo_running" },
  { query: "What should I do about my sore knee?", expected: "demo_running" },
  { query: "At what temperature should the squash traybake roast?", expected: "demo_newsletter" },
  { query: "When are the rainwater tanks arriving?", expected: "demo_garden" },
  { query: "How can I lower my car insurance price?", expected: "demo_insurance" },
  { query: "What could I give Sam?", expected: "demo_gifts" },
  { query: "Which grammar topic am I studying this month?", expected: "demo_spanish" },
  { query: "Where do the soil readings get sent?", expected: "demo_plants" },
  { query: "Where should I keep copies of my documents?", expected: "demo_tax" },
  { query: "What should I ask the mechanic about the brakes?", expected: "demo_bike" },
  { query: "How is keyword search different from semantic search here?", expected: "demo_guide_vectors" },
  // Metadata filter: only notes tagged "home" are eligible.
  { query: "What is my budget?", expected: "demo_kitchen", filters: { tags: ["home"] } },
];
