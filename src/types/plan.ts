/**
 * Plan interface matching backend contract
 * Single source of truth for plan structure
 */
export type Plan = {
  selected: number[];
  order: number[];
  durations: number[];
  transitions?: ("crossfade" | "fade_black" | "dissolve")[];
  memoryNote?: string;
  usedPlanner?: "ai" | "fallback";
  // Legacy fields that might exist but should not be accessed:
  // beats?: never; // Explicitly excluded
  // music?: never; // Explicitly excluded
  // audioPlan?: never; // Explicitly excluded
};



 * Plan interface matching backend contract
 * Single source of truth for plan structure
 */
export type Plan = {
  selected: number[];
  order: number[];
  durations: number[];
  editRhythmProfile?: {
    avgShotLength: number;
    minShotLength: number;
    maxShotLength: number;
    introBreath: number;
    climaxCompression: number;
    resolveBreath: number;
  };
  transitions?: (
    | "crossfade"
    | "fade_black"
    | "dissolve"
    | "hard_cut"
    | "match_dissolve"
    | "breath_hold"
    | "dip_to_black_micro"
    | "push_through"
  )[];
  memoryNote?: string;
  usedPlanner?: "ai" | "fallback";
  // Legacy fields that might exist but should not be accessed:
  // beats?: never; // Explicitly excluded
  // music?: never; // Explicitly excluded
  // audioPlan?: never; // Explicitly excluded
};














