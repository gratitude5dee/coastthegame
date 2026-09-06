/**
 * Missions = shots (goal.md §3.3 MIS-*, SCH-3). Constraints are machine-checkable; the shot meter and the judge run the
 * same evaluators (MIS-2). Astra grades aesthetics only and never decides pass/fail.
 */
export type Constraint =
  | { kind: 'cameraHeight'; min_m?: number; max_m?: number }
  | { kind: 'cameraAngle'; pitchMin?: number; pitchMax?: number } // degrees, negative = looking down
  | { kind: 'subjectInFrame'; subject: string; minShare: number } // share of frames with the subject's bounds inside the frustum
  | { kind: 'timePreset'; is: 'golden' | 'blue' | 'night' | 'fog_noon' }
  | { kind: 'duration_s'; target: number; tolerance: number }
  | { kind: 'beatSync'; event: 'hop' | 'jump' | 'cut'; window_ms: number }
  | { kind: 'cell'; is: string }
  | { kind: 'lens_mm'; min?: number; max?: number };

export interface Mission {
  id: string;
  title: string;
  trackId: string;
  barRange: [number, number];
  look: string; // LUT + Turbo style preset name (MIS-6)
  cell: string;
  constraints: Constraint[];
  hints: Partial<Record<Constraint['kind'], string>>; // one actionable, numeric hint per constraint (MIS-3)
  reward: { stars: 1 | 2 | 3; unlock?: string };
  takesMax: number; // 3 (MIS-3)
  authoredBy: 'planner' | 'human';
  approvedBy?: string; // MIS-5: GRATITUD3 signs off the 12 v1 missions
}

export interface ConstraintResult {
  kind: Constraint['kind'];
  pass: boolean;
  score: number; // 0..1 (drives the shot meter fill)
  hint?: string;
}

export interface Verdict {
  missionId: string;
  takeId: string;
  results: ConstraintResult[];
  stars: 0 | 1 | 2 | 3;
  aesthetic?: { score: number; keyframes: string[] }; // Astra vision, 0–10, advisory only
}
