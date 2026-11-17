/**
 * Render-time labels for the catalog's controlled vocabularies.
 *
 * Catalog ids stay canonical English in data and records; this module is a
 * display layer only. It covers every id in the frozen v1 vocabulary, and an
 * unknown future id falls back to a humanized id instead of an empty label.
 * Used by the web exercise library and available to the mobile follow-up.
 */

import type {
  Difficulty,
  EquipmentCategory,
  EquipmentItem,
  Force,
  Mechanics,
  MovementPattern,
  MuscleId,
} from "@agent-fit-trace/core";
import type { AppLanguage } from "./index.ts";

interface LabelPair {
  readonly en: string;
  readonly zh: string;
}

const PATTERNS: Record<MovementPattern, LabelPair> = {
  squat: { en: "Squat", zh: "深蹲" },
  hinge: { en: "Hinge", zh: "髋铰链" },
  lunge: { en: "Lunge / single leg", zh: "弓步/单腿" },
  horizontal_push: { en: "Horizontal push", zh: "水平推" },
  vertical_push: { en: "Vertical push", zh: "垂直推" },
  horizontal_pull: { en: "Horizontal pull", zh: "水平拉" },
  vertical_pull: { en: "Vertical pull", zh: "垂直拉" },
  core: { en: "Core", zh: "核心" },
  biceps: { en: "Biceps", zh: "肱二头" },
  triceps: { en: "Triceps", zh: "肱三头" },
  shoulders: { en: "Shoulders", zh: "肩部孤立" },
  legs: { en: "Legs", zh: "腿部孤立" },
  cardio: { en: "Cardio", zh: "有氧" },
  mobility: { en: "Mobility", zh: "灵活性" },
};

const MUSCLES: Record<MuscleId, LabelPair> = {
  abdominals: { en: "Abdominals", zh: "腹肌" },
  abductors: { en: "Abductors", zh: "外展肌" },
  adductors: { en: "Adductors", zh: "内收肌" },
  biceps: { en: "Biceps", zh: "肱二头肌" },
  calves: { en: "Calves", zh: "小腿" },
  chest: { en: "Chest", zh: "胸大肌" },
  forearms: { en: "Forearms", zh: "前臂" },
  glutes: { en: "Glutes", zh: "臀大肌" },
  hamstrings: { en: "Hamstrings", zh: "腘绳肌" },
  "hip flexors": { en: "Hip flexors", zh: "髋屈肌" },
  lats: { en: "Lats", zh: "背阔肌" },
  "lower back": { en: "Lower back", zh: "下背/竖脊肌" },
  "middle back": { en: "Middle back", zh: "中背（菱形肌/斜方肌中束）" },
  neck: { en: "Neck", zh: "颈部" },
  obliques: { en: "Obliques", zh: "腹斜肌" },
  quadriceps: { en: "Quadriceps", zh: "股四头肌" },
  shoulders: { en: "Shoulders", zh: "三角肌" },
  traps: { en: "Traps", zh: "斜方肌" },
  triceps: { en: "Triceps", zh: "肱三头肌" },
};

const EQUIPMENT: Record<EquipmentCategory, LabelPair> = {
  barbell: { en: "Barbell", zh: "杠铃" },
  ez_bar: { en: "EZ bar", zh: "EZ 杆" },
  dumbbell: { en: "Dumbbell", zh: "哑铃" },
  kettlebell: { en: "Kettlebell", zh: "壶铃" },
  machine: { en: "Machine", zh: "固定器械" },
  cable: { en: "Cable", zh: "绳索" },
  bodyweight: { en: "Bodyweight", zh: "自重" },
  band: { en: "Band", zh: "弹力带" },
  cardio_machine: { en: "Cardio machine", zh: "有氧器械" },
  other: { en: "Other", zh: "其他" },
};

const EQUIPMENT_ITEMS: Record<EquipmentItem, LabelPair> = {
  ab_wheel: { en: "Ab wheel", zh: "健腹轮" },
  bar: { en: "Bar", zh: "杠铃杆" },
  bench: { en: "Bench", zh: "卧推凳" },
  bike: { en: "Bike", zh: "自行车" },
  box: { en: "Box", zh: "跳箱" },
  calf_machine: { en: "Calf machine", zh: "提踵机" },
  dip_bars: { en: "Dip bars", zh: "双杠" },
  elliptical: { en: "Elliptical", zh: "椭圆机" },
  ghd_bench: { en: "GHD bench", zh: "GHD 凳" },
  hack_squat_machine: { en: "Hack squat machine", zh: "哈克深蹲机" },
  jump_rope: { en: "Jump rope", zh: "跳绳" },
  leg_curl_machine: { en: "Leg curl machine", zh: "腿弯举机" },
  leg_extension_machine: { en: "Leg extension machine", zh: "腿屈伸机" },
  leg_press_machine: { en: "Leg press machine", zh: "腿举机" },
  parallel_bars: { en: "Parallel bars", zh: "双杠" },
  pull_up_bar: { en: "Pull-up bar", zh: "单杠" },
  reverse_hyper_machine: { en: "Reverse hyper machine", zh: "反向超伸凳" },
  rope: { en: "Rope", zh: "绳索" },
  rower: { en: "Rower", zh: "划船机" },
  smith_machine: { en: "Smith machine", zh: "史密斯机" },
  stair_climber: { en: "Stair climber", zh: "爬楼机" },
  stationary_bike: { en: "Stationary bike", zh: "固定自行车" },
  suspension_trainer: { en: "Suspension trainer", zh: "悬吊训练器" },
  trap_bar: { en: "Trap bar", zh: "六角杠铃" },
  treadmill: { en: "Treadmill", zh: "跑步机" },
  v_bar: { en: "V bar", zh: "V 型把手" },
};

const DIFFICULTIES: Record<Difficulty, LabelPair> = {
  beginner: { en: "Beginner", zh: "新手" },
  intermediate: { en: "Intermediate", zh: "进阶" },
  expert: { en: "Expert", zh: "高手" },
};

const MECHANICS: Record<Mechanics, LabelPair> = {
  compound: { en: "Compound", zh: "复合动作" },
  isolation: { en: "Isolation", zh: "孤立动作" },
};

const FORCES: Record<Force, LabelPair> = {
  push: { en: "Push", zh: "推" },
  pull: { en: "Pull", zh: "拉" },
  static: { en: "Static", zh: "静态" },
};

function humanize(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function label(pair: LabelPair | undefined, language: AppLanguage, id: string): string {
  if (pair === undefined) return humanize(id);
  return language === "zh" ? pair.zh : pair.en;
}

export function displayMovementPattern(
  language: AppLanguage,
  pattern: MovementPattern,
): string {
  return label(PATTERNS[pattern], language, pattern);
}

export function displayMuscle(language: AppLanguage, muscle: MuscleId): string {
  return label(MUSCLES[muscle], language, muscle);
}

export function displayEquipmentCategory(
  language: AppLanguage,
  category: EquipmentCategory,
): string {
  return label(EQUIPMENT[category], language, category);
}

export function displayEquipmentItem(
  language: AppLanguage,
  item: EquipmentItem,
): string {
  return label(EQUIPMENT_ITEMS[item], language, item);
}

export function displayDifficulty(
  language: AppLanguage,
  difficulty: Difficulty,
): string {
  return label(DIFFICULTIES[difficulty], language, difficulty);
}

export function displayMechanics(language: AppLanguage, mechanics: Mechanics): string {
  return label(MECHANICS[mechanics], language, mechanics);
}

export function displayForce(language: AppLanguage, force: Force): string {
  return label(FORCES[force], language, force);
}

export { humanize as humanizeExerciseMetadataId };
