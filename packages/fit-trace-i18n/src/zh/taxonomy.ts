/**
 * Chinese display layer — exercise-catalog taxonomy labels.
 *
 * These are controlled-vocabulary labels from the catalog, keyed by the
 * canonical ids in `@agent-fit-trace/core`; they are not interface message
 * keys and are therefore kept out of `ZH_MESSAGES`. A missing lookup falls
 * back to the id in `taxonomy.ts` rather than showing a raw key.
 *
 * The muscle labels follow `docs/exercise-catalog-mapping-v0.md`; the catalog
 * is still under content review, so these labels describe catalog data and are
 * not coaching guidance.
 */

import type {
  Difficulty,
  EquipmentCategory,
  Force,
  Mechanics,
  MovementPattern,
  MuscleId,
} from "@agent-fit-trace/core";

export const ZH_MOVEMENT_PATTERNS: Record<MovementPattern, string> = {
  squat: "深蹲",
  hinge: "髋铰链",
  lunge: "弓步",
  horizontal_push: "水平推",
  vertical_push: "垂直推",
  horizontal_pull: "水平拉",
  vertical_pull: "垂直拉",
  core: "核心",
  biceps: "肱二头",
  triceps: "肱三头",
  shoulders: "肩部",
  legs: "腿部",
  cardio: "有氧",
  mobility: "灵活性",
};

export const ZH_MUSCLES: Record<MuscleId, string> = {
  abdominals: "腹肌",
  abductors: "外展肌",
  adductors: "内收肌",
  biceps: "肱二头肌",
  calves: "小腿",
  chest: "胸大肌",
  forearms: "前臂",
  glutes: "臀大肌",
  hamstrings: "腘绳肌",
  "hip flexors": "髋屈肌",
  lats: "背阔肌",
  "lower back": "下背",
  "middle back": "中背",
  neck: "颈部",
  obliques: "腹斜肌",
  quadriceps: "股四头肌",
  shoulders: "三角肌",
  traps: "斜方肌",
  triceps: "肱三头肌",
};

export const ZH_EQUIPMENT_CATEGORIES: Record<EquipmentCategory, string> = {
  barbell: "杠铃",
  ez_bar: "EZ 杆",
  dumbbell: "哑铃",
  kettlebell: "壶铃",
  machine: "器械",
  cable: "绳索",
  bodyweight: "自重",
  band: "弹力带",
  cardio_machine: "有氧器械",
  other: "其他",
};

export const ZH_DIFFICULTIES: Record<Difficulty, string> = {
  beginner: "新手",
  intermediate: "进阶",
  expert: "高手",
};

export const ZH_MECHANICS: Record<Mechanics, string> = {
  compound: "复合",
  isolation: "孤立",
};

export const ZH_FORCES: Record<Force, string> = {
  push: "推",
  pull: "拉",
  static: "静力",
};
