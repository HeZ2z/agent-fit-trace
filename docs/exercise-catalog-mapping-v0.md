# 动作库数据映射表 v0（工作稿）

> 状态：**v1 数据与实现已在 feature 分支落地，待评审合并**；内容审校（49 条要点重写、肌群/器械复核）仍未完成。本文保留为审校工作底稿，不是产品契约文档。
> 生成日期：2026-10-20。数据来源：gengyueworks/gym-exercise-guide（Unlicense，commit `ed41bb3a`）+ yuhonas/free-exercise-db（Unlicense，main `f00c92c7`）。
> 范围：194 条 = 力量核心 178 条 + 有氧种子 8 条 + 灵活性种子 8 条。

## Implementation status (2026-10-20)

- **数据已提交**：194 条动作写入 [`data/exercise-catalog/catalog.v1.json`](../data/exercise-catalog/catalog.v1.json)，由 [`scripts/build-exercise-catalog.mjs`](../scripts/build-exercise-catalog.mjs) 校验并生成共享核心数据；66 条改名已冻结，seed 旧名保留为中文别名。
- **代码已落地**：共享核心 catalog + resolver、i18n 中文显示表、中文 domain 文案内的动作名、分析归一化、Web 自动补全/显示、共享 suggestion search、Mobile Log 自动补全都在 `feat/exercise-catalog` 分支上（核心 `9c3e8938`、i18n `3b15460a`/`62d5baa3`、analysis `89390336`、web `0d0b0820`、mobile `b9185d1f`/`ff4aa13d`/`1c4d63a5`）。
- **审校仍未完成**：49 条要点/常见错误重写、19 个粗粒度肌群在复合动作上的复核、器械 `items[]` 抽查均未经过教练审定；`content_status` 仍为 `template` (145) / `rewrite` (49)，动作内容暂不作为权威依据。2026-10-22 已修正 hip flexor/step-up/oblique 肌群映射，并补齐 21 条高频动作的器械 `items[]`；仍有 109 条 `items[]` 为空、51 条无次要肌群，待继续复核。
- **无媒体**：v1 不包含任何图片或视频。
- **范围不变**：记录 schema / API 未改动；本表映射内容（第 2、3 节与附录）除本节状态说明外保持不变。

## 1. 已锁定的决定

1. **建议层定位不变**：动作库只辅助录入、分析归一化、计划/替代建议；不拦记录、不强制选库、不改写历史。
2. **194 条构成已确认**：12 个力量模式 178 条 + 有氧 8 条 + 灵活性 8 条；后续再扩。
3. **改名由我方裁决并冻结**：共 66 条建议改名，旧名保留为中文别名；完整对照见附录 A。
4. **dips 保留两条**：`chest_dip` / `triceps_dip` 分别保留；在关系字段里标 `variant_of`（同一动作的侧重变式），暂不合并。
5. **器械用数组模型**：`category` + `items[]`；本表给初版映射，items 允许后续补充。
6. **记录 schema / API 仍不改**；本阶段只产出数据映射与审校状态。

## 2. 受控词表

### 2.1 动作模式

| pattern | 中文 | 条目数 |
|---|---|---|
| `squat` | 深蹲 | 16 |
| `hinge` | 髋铰链 | 18 |
| `lunge` | 弓步/单腿 | 10 |
| `horizontal_push` | 水平推 | 22 |
| `vertical_push` | 垂直推 | 14 |
| `horizontal_pull` | 水平拉 | 16 |
| `vertical_pull` | 垂直拉 | 10 |
| `core` | 核心 | 16 |
| `biceps` | 肱二头 | 14 |
| `triceps` | 肱三头 | 14 |
| `shoulders` | 肩部孤立 | 14 |
| `legs` | 腿部孤立 | 14 |
| `cardio` | 有氧 | 8 |
| `mobility` | 灵活性 | 8 |

### 2.2 肌群（先用 free-exercise-db 的 17 个粗粒度标签，后续再做两级细化）

| muscle id | 中文 |
|---|---|
| `abdominals` | 腹肌 |
| `biceps` | 肱二头肌 |
| `calves` | 小腿 |
| `chest` | 胸大肌 |
| `forearms` | 前臂 |
| `glutes` | 臀大肌 |
| `hamstrings` | 腘绳肌 |
| `lats` | 背阔肌 |
| `lower back` | 下背/竖脊肌 |
| `middle back` | 中背（菱形肌/斜方肌中束） |
| `neck` | 颈部 |
| `quadriceps` | 股四头肌 |
| `shoulders` | 三角肌 |
| `traps` | 斜方肌 |
| `triceps` | 肱三头肌 |
| `adductors` | 内收肌 |
| `abductors` | 外展肌 |
| `hip flexors` | 髋屈肌 |
| `obliques` | 腹斜肌 |

> 说明：primary/secondary 直接继承 free-exercise-db；本表不做训练学上的重新判定。正式入库前需要按我们的 taxonomy 复核，尤其是 Clean/硬拉类的主肌群。

### 2.3 器械模型

- `category`：barbell / ez_bar / dumbbell / kettlebell / machine / cable / bodyweight / band / cardio_machine / other
- `items[]`：bench、pull_up_bar、dip_bars、parallel_bars、rope、v_bar、smith_machine、leg_press_machine、hack_squat_machine、leg_extension_machine、leg_curl_machine、calf_machine、reverse_hyper_machine、ghd_bench、treadmill、bike、stationary_bike、elliptical、rower、stair_climber、jump_rope、ab_wheel、suspension_trainer 等。
- 本表的 items 是初版建议，允许后续增补；不把“支撑物”和“阻力来源”混成一个字段。

### 2.4 ID / 别名 / 来源规则

- ID：ASCII snake_case、全局唯一、不复用；弃用只加 `deprecated`，不删除。
- 别名：中文别名至少包含 seed 旧名（若改名）与常用俗称；英文别名包含去限定词版本与常见缩写。
- 来源：每条同时记录 free-exercise-db 名称（Unlicense）与 guide 页面（Unlicense）；正式数据文件再加 `source_url/license/retrieved_at`。

## 3. 数据映射表


### 深蹲（16）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `barbell_squat` | 杠铃深蹲 | Barbell Squat | 股四头肌 | 小腿、臀大肌、腘绳肌、下背/竖脊肌 | barbell | — | 新手 | 沿用 | 需重写 | Barbell_Squat.md |
| 2 | `front_squat` | 前蹲 | Front Squat (Clean Grip) | 股四头肌 | 腹肌、臀大肌、腘绳肌 | barbell | — | 进阶 | 改名 | 需重写 | Front_Squat_Clean_Grip.md |
| 3 | `barbell_hack_squat` | 杠铃哈克深蹲 | Barbell Hack Squat | 股四头肌 | 小腿、前臂、腘绳肌 | barbell | — | 进阶 | 沿用 | 需重写 | Barbell_Hack_Squat.md |
| 4 | `hack_squat` | 哈克深蹲 | Hack Squat | 股四头肌 | 小腿、臀大肌、腘绳肌 | machine | hack_squat_machine | 新手 | 沿用 | 模板初稿 | Hack_Squat.md |
| 5 | `goblet_squat` | 高脚杯深蹲 | Goblet Squat | 股四头肌 | 小腿、臀大肌、腘绳肌、三角肌 | kettlebell | — | 新手 | 沿用 | 模板初稿 | Goblet_Squat.md |
| 6 | `dumbbell_squat` | 哑铃深蹲 | Dumbbell Squat | 股四头肌 | 小腿、臀大肌、腘绳肌、下背/竖脊肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Dumbbell_Squat.md |
| 7 | `bodyweight_squat` | 自重深蹲 | Bodyweight Squat | 股四头肌 | 臀大肌、腘绳肌 | bodyweight | — | 新手 | 沿用 | 模板初稿 | Bodyweight_Squat.md |
| 8 | `box_squat` | 箱式深蹲 | Box Squat | 股四头肌 | 内收肌、小腿、臀大肌、腘绳肌、下背/竖脊肌 | barbell | box | 进阶 | 改名 | 需重写 | Box_Squat.md |
| 9 | `zercher_squat` | 泽奇深蹲 | Zercher Squats | 股四头肌 | 小腿、臀大肌、腘绳肌 | barbell | — | 高手 | 沿用 | 需重写 | Zercher_Squats.md |
| 10 | `smith_machine_squat` | 史密斯机深蹲 | Smith Machine Squat | 股四头肌 | 小腿、臀大肌、腘绳肌、下背/竖脊肌 | machine | smith_machine | 新手 | 沿用 | 模板初稿 | Smith_Machine_Squat.md |
| 11 | `leg_press` | 腿举 | Leg Press | 股四头肌 | 小腿、臀大肌、腘绳肌 | machine | leg_press_machine | 新手 | 改名 | 模板初稿 | Leg_Press.md |
| 12 | `narrow_stance_leg_press` | 窄距腿举 | Narrow Stance Leg Press | 股四头肌 | 小腿、臀大肌、腘绳肌 | machine | leg_press_machine | 进阶 | 改名 | 模板初稿 | Narrow_Stance_Leg_Press.md |
| 13 | `kettlebell_pistol_squat` | 壶铃手枪深蹲 | Kettlebell Pistol Squat | 股四头肌 | 小腿、臀大肌、腘绳肌、三角肌 | kettlebell | — | 高手 | 改名 | 模板初稿 | Kettlebell_Pistol_Squat.md |
| 14 | `weighted_sissy_squat` | 负重西斯深蹲 | Weighted Sissy Squat | 股四头肌 | 小腿、臀大肌、腘绳肌 | barbell | — | 高手 | 改名 | 需重写 | Weighted_Sissy_Squat.md |
| 15 | `plie_dumbbell_squat` | 相扑哑铃深蹲 | Plie Dumbbell Squat | 股四头肌 | 腹肌、小腿、臀大肌、腘绳肌 | dumbbell | — | 新手 | 改名 | 模板初稿 | Plie_Dumbbell_Squat.md |
| 16 | `jefferson_squat` | 杰斐逊深蹲 | Jefferson Squats | 股四头肌 | 小腿、臀大肌、腘绳肌、下背/竖脊肌、斜方肌 | barbell | — | 进阶 | 沿用 | 需重写 | Jefferson_Squats.md |

### 髋铰链（18）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `barbell_deadlift` | 杠铃硬拉 | Barbell Deadlift | 下背/竖脊肌 | 小腿、前臂、臀大肌、腘绳肌、背阔肌、中背（菱形肌/斜方肌中束）、股四头肌、斜方肌 | barbell | — | 进阶 | 沿用 | 需重写 | Barbell_Deadlift.md |
| 2 | `romanian_deadlift` | 罗马尼亚硬拉 | Romanian Deadlift | 腘绳肌 | 小腿、臀大肌、下背/竖脊肌 | barbell | — | 进阶 | 沿用 | 需重写 | Romanian_Deadlift.md |
| 3 | `sumo_deadlift` | 相扑硬拉 | Sumo Deadlift | 腘绳肌 | 内收肌、前臂、臀大肌、下背/竖脊肌、中背（菱形肌/斜方肌中束）、股四头肌、斜方肌 | barbell | — | 进阶 | 沿用 | 需重写 | Sumo_Deadlift.md |
| 4 | `trap_bar_deadlift` | 六角杠铃硬拉 | Trap Bar Deadlift | 股四头肌 | 臀大肌、腘绳肌 | barbell | trap_bar | 新手 | 沿用 | 需重写 | Trap_Bar_Deadlift.md |
| 5 | `stiff_legged_barbell_deadlift` | 直腿杠铃硬拉 | Stiff-Legged Barbell Deadlift | 腘绳肌 | 臀大肌、下背/竖脊肌 | barbell | — | 进阶 | 沿用 | 需重写 | Stiff-Legged_Barbell_Deadlift.md |
| 6 | `stiff_legged_dumbbell_deadlift` | 直腿哑铃硬拉 | Stiff-Legged Dumbbell Deadlift | 腘绳肌 | 臀大肌、下背/竖脊肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Stiff-Legged_Dumbbell_Deadlift.md |
| 7 | `good_morning` | 早安式 | Good Morning | 腘绳肌 | 腹肌、臀大肌、下背/竖脊肌 | barbell | — | 进阶 | 改名 | 需重写 | Good_Morning.md |
| 8 | `band_good_morning` | 弹力带早安式 | Band Good Morning | 腘绳肌 | 臀大肌、下背/竖脊肌 | band | — | 新手 | 改名 | 模板初稿 | Band_Good_Morning.md |
| 9 | `barbell_hip_thrust` | 杠铃臀推 | Barbell Hip Thrust | 臀大肌 | 小腿、腘绳肌 | barbell | bench | 进阶 | 沿用 | 模板初稿 | Barbell_Hip_Thrust.md |
| 10 | `barbell_glute_bridge` | 杠铃臀桥 | Barbell Glute Bridge | 臀大肌 | 小腿、腘绳肌 | barbell | — | 进阶 | 沿用 | 模板初稿 | Barbell_Glute_Bridge.md |
| 11 | `single_leg_glute_bridge` | 单腿臀桥 | Single Leg Glute Bridge | 臀大肌 | 腘绳肌 | bodyweight | — | 新手 | 沿用 | 模板初稿 | Single_Leg_Glute_Bridge.md |
| 12 | `pull_through` | 绳索胯下后拉 | Pull Through | 臀大肌 | 腘绳肌、下背/竖脊肌 | cable | rope | 新手 | 改名 | 模板初稿 | Pull_Through.md |
| 13 | `kettlebell_one_legged_deadlift` | 壶铃单腿硬拉 | Kettlebell One-Legged Deadlift | 腘绳肌 | 臀大肌、下背/竖脊肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | Kettlebell_One-Legged_Deadlift.md |
| 14 | `deficit_deadlift` | 垫高硬拉 | Deficit Deadlift | 下背/竖脊肌 | 前臂、臀大肌、腘绳肌、中背（菱形肌/斜方肌中束）、股四头肌、斜方肌 | barbell | — | 进阶 | 沿用 | 需重写 | Deficit_Deadlift.md |
| 15 | `rack_pulls` | 架上硬拉 | Rack Pulls | 下背/竖脊肌 | 前臂、臀大肌、腘绳肌、斜方肌 | barbell | — | 进阶 | 改名 | 需重写 | Rack_Pulls.md |
| 16 | `glute_ham_raise` | 臀腘绳肌上举（器械） | Glute Ham Raise | 腘绳肌 | 小腿、臀大肌 | machine | ghd_bench | 进阶 | 改名 | 模板初稿 | Glute_Ham_Raise.md |
| 17 | `natural_glute_ham_raise` | 自然臀腘绳肌上举 | Natural Glute Ham Raise | 腘绳肌 | 小腿、臀大肌、下背/竖脊肌 | bodyweight | — | 进阶 | 沿用 | 模板初稿 | Natural_Glute_Ham_Raise.md |
| 18 | `cable_deadlift` | 绳索硬拉 | Cable Deadlifts | 股四头肌 | 前臂、臀大肌、腘绳肌、下背/竖脊肌 | cable | — | 新手 | 沿用 | 模板初稿 | Cable_Deadlifts.md |

### 弓步/单腿（10）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `barbell_lunge` | 杠铃箭步蹲 | Barbell Lunge | 股四头肌 | 小腿、臀大肌、腘绳肌 | barbell | — | 进阶 | 沿用 | 模板初稿 | Barbell_Lunge.md |
| 2 | `dumbbell_lunge` | 哑铃箭步蹲 | Dumbbell Lunges | 股四头肌 | 小腿、臀大肌、腘绳肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Dumbbell_Lunges.md |
| 3 | `dumbbell_rear_lunge` | 哑铃后撤箭步蹲 | Dumbbell Rear Lunge | 股四头肌 | 小腿、臀大肌、腘绳肌 | dumbbell | — | 进阶 | 改名 | 模板初稿 | Dumbbell_Rear_Lunge.md |
| 4 | `barbell_walking_lunge` | 杠铃行走箭步蹲 | Barbell Walking Lunge | 股四头肌 | 小腿、臀大肌、腘绳肌 | barbell | — | 新手 | 沿用 | 需重写 | Barbell_Walking_Lunge.md |
| 5 | `bodyweight_walking_lunge` | 自重行走箭步蹲 | Bodyweight Walking Lunge | 股四头肌 | 小腿、臀大肌、腘绳肌 | bodyweight | — | 新手 | 沿用 | 需重写 | Bodyweight_Walking_Lunge.md |
| 6 | `barbell_step_up` | 杠铃登阶 | Barbell Step Ups | 股四头肌 | 小腿、臀大肌、腘绳肌、股四头肌 | barbell | box | 进阶 | 沿用 | 模板初稿 | Barbell_Step_Ups.md |
| 7 | `dumbbell_step_up` | 哑铃登阶 | Dumbbell Step Ups | 股四头肌 | 小腿、臀大肌、腘绳肌 | dumbbell | box | 进阶 | 沿用 | 模板初稿 | Dumbbell_Step_Ups.md |
| 8 | `split_squat_with_dumbbells` | 哑铃分腿蹲 | Split Squat with Dumbbells | 股四头肌 | 臀大肌、腘绳肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Split_Squat_with_Dumbbells.md |
| 9 | `smith_single_leg_split_squat` | 史密斯机单腿分腿蹲 | Smith Single-Leg Split Squat | 股四头肌 | 小腿、臀大肌、腘绳肌 | machine | smith_machine | 新手 | 沿用 | 模板初稿 | Smith_Single-Leg_Split_Squat.md |
| 10 | `step_up_knee_raise` | 登阶提膝 | Step-up with Knee Raise | 臀大肌 | 腘绳肌、股四头肌 | bodyweight | box | 新手 | 改名 | 模板初稿 | Step-up_with_Knee_Raise.md |

### 水平推（22）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `barbell_bench_press` | 杠铃卧推 | Barbell Bench Press - Medium Grip | 胸大肌 | 三角肌、肱三头肌 | barbell | bench | 新手 | 改名 | 模板初稿 | Barbell_Bench_Press_-_Medium_Grip.md |
| 2 | `incline_barbell_bench_press` | 上斜杠铃卧推 | Barbell Incline Bench Press - Medium Grip | 胸大肌 | 三角肌、肱三头肌 | barbell | bench | 新手 | 改名 | 模板初稿 | Barbell_Incline_Bench_Press_-_Medium_Grip.md |
| 3 | `decline_barbell_bench_press` | 下斜杠铃卧推 | Decline Barbell Bench Press | 胸大肌 | 三角肌、肱三头肌 | barbell | bench | 新手 | 沿用 | 模板初稿 | Decline_Barbell_Bench_Press.md |
| 4 | `close_grip_barbell_bench_press` | 窄握杠铃卧推 | Close-Grip Barbell Bench Press | 肱三头肌 | 胸大肌、三角肌 | barbell | bench | 新手 | 沿用 | 需重写 | Close-Grip_Barbell_Bench_Press.md |
| 5 | `wide_grip_barbell_bench_press` | 宽握杠铃卧推 | Wide-Grip Barbell Bench Press | 胸大肌 | 三角肌、肱三头肌 | barbell | bench | 进阶 | 沿用 | 模板初稿 | Wide-Grip_Barbell_Bench_Press.md |
| 6 | `dumbbell_bench_press` | 哑铃卧推 | Dumbbell Bench Press | 胸大肌 | 三角肌、肱三头肌 | dumbbell | bench | 新手 | 改名 | 模板初稿 | Dumbbell_Bench_Press.md |
| 7 | `dumbbell_bench_press_with_neutral_grip` | 哑铃对握卧推 | Dumbbell Bench Press with Neutral Grip | 胸大肌 | 三角肌、肱三头肌 | dumbbell | bench | 新手 | 改名 | 模板初稿 | Dumbbell_Bench_Press_with_Neutral_Grip.md |
| 8 | `decline_dumbbell_bench_press` | 下斜哑铃卧推 | Decline Dumbbell Bench Press | 胸大肌 | 三角肌、肱三头肌 | dumbbell | bench | 新手 | 沿用 | 模板初稿 | Decline_Dumbbell_Bench_Press.md |
| 9 | `one_arm_dumbbell_bench_press` | 单臂哑铃卧推 | One Arm Dumbbell Bench Press | 胸大肌 | 三角肌、肱三头肌 | dumbbell | bench | 新手 | 沿用 | 模板初稿 | One_Arm_Dumbbell_Bench_Press.md |
| 10 | `incline_dumbbell_press` | 上斜哑铃卧推 | Incline Dumbbell Press | 胸大肌 | 三角肌、肱三头肌 | dumbbell | bench | 新手 | 沿用 | 模板初稿 | Incline_Dumbbell_Press.md |
| 11 | `dumbbell_fly` | 哑铃飞鸟 | Dumbbell Flyes | 胸大肌 | — | dumbbell | — | 新手 | 沿用 | 模板初稿 | Dumbbell_Flyes.md |
| 12 | `incline_dumbbell_fly` | 上斜哑铃飞鸟 | Incline Dumbbell Flyes | 胸大肌 | 三角肌 | dumbbell | bench | 新手 | 沿用 | 模板初稿 | Incline_Dumbbell_Flyes.md |
| 13 | `decline_dumbbell_fly` | 下斜哑铃飞鸟 | Decline Dumbbell Flyes | 胸大肌 | — | dumbbell | bench | 新手 | 沿用 | 模板初稿 | Decline_Dumbbell_Flyes.md |
| 14 | `butterfly` | 蝴蝶机夹胸 | Butterfly | 胸大肌 | — | machine | — | 新手 | 沿用 | 模板初稿 | Butterfly.md |
| 15 | `cable_chest_press` | 绳索胸推 | Cable Chest Press | 胸大肌 | 三角肌、肱三头肌 | cable | — | 新手 | 沿用 | 模板初稿 | Cable_Chest_Press.md |
| 16 | `incline_cable_chest_press` | 上斜绳索胸推 | Incline Cable Chest Press | 胸大肌 | 三角肌、肱三头肌 | cable | bench | 新手 | 沿用 | 模板初稿 | Incline_Cable_Chest_Press.md |
| 17 | `flat_bench_cable_fly` | 平板绳索飞鸟 | Flat Bench Cable Flyes | 胸大肌 | — | cable | — | 进阶 | 改名 | 模板初稿 | Flat_Bench_Cable_Flyes.md |
| 18 | `leverage_chest_press` | 器械推胸 | Leverage Chest Press | 胸大肌 | 三角肌、肱三头肌 | machine | — | 新手 | 改名 | 模板初稿 | Leverage_Chest_Press.md |
| 19 | `machine_bench_press` | 器械卧推 | Machine Bench Press | 胸大肌 | 三角肌、肱三头肌 | machine | bench | 新手 | 沿用 | 模板初稿 | Machine_Bench_Press.md |
| 20 | `push_up` | 俯卧撑 | Pushups | 胸大肌 | 三角肌、肱三头肌 | bodyweight | — | 新手 | 沿用 | 需重写 | Pushups.md |
| 21 | `chest_dip` | 双杠臂屈伸（胸肌版） | Dips - Chest Version | 胸大肌 | 三角肌、肱三头肌 | bodyweight | dip_bars | 进阶 | 沿用 | 需重写 | Dips_-_Chest_Version.md |
| 22 | `standing_cable_chest_press` | 站姿绳索胸推 | Standing Cable Chest Press | 胸大肌 | 三角肌、肱三头肌 | cable | — | 新手 | 沿用 | 模板初稿 | Standing_Cable_Chest_Press.md |

### 垂直推（14）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `standing_military_press` | 站姿杠铃推举 | Standing Military Press | 三角肌 | 肱三头肌 | barbell | — | 新手 | 改名 | 模板初稿 | Standing_Military_Press.md |
| 2 | `seated_barbell_military_press` | 坐姿杠铃推举 | Seated Barbell Military Press | 三角肌 | 肱三头肌 | barbell | — | 进阶 | 改名 | 模板初稿 | Seated_Barbell_Military_Press.md |
| 3 | `dumbbell_shoulder_press` | 哑铃肩推 | Dumbbell Shoulder Press | 三角肌 | 肱三头肌 | dumbbell | — | 进阶 | 沿用 | 模板初稿 | Dumbbell_Shoulder_Press.md |
| 4 | `dumbbell_one_arm_shoulder_press` | 单臂哑铃肩推 | Dumbbell One-Arm Shoulder Press | 三角肌 | 肱三头肌 | dumbbell | — | 进阶 | 改名 | 模板初稿 | Dumbbell_One-Arm_Shoulder_Press.md |
| 5 | `kettlebell_arnold_press` | 壶铃阿诺德推举 | Kettlebell Arnold Press | 三角肌 | 肱三头肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | Kettlebell_Arnold_Press.md |
| 6 | `smith_machine_shoulder_press` | 史密斯机肩推 | Smith Machine Overhead Shoulder Press | 三角肌 | 肱三头肌 | machine | smith_machine | 新手 | 改名 | 模板初稿 | Smith_Machine_Overhead_Shoulder_Press.md |
| 7 | `leverage_shoulder_press` | 器械肩推 | Leverage Shoulder Press | 三角肌 | 肱三头肌 | machine | — | 新手 | 改名 | 模板初稿 | Leverage_Shoulder_Press.md |
| 8 | `cable_shoulder_press` | 绳索肩推 | Cable Shoulder Press | 三角肌 | 肱三头肌 | cable | — | 新手 | 沿用 | 模板初稿 | Cable_Shoulder_Press.md |
| 9 | `seated_cable_shoulder_press` | 坐姿绳索肩推 | Seated Cable Shoulder Press | 三角肌 | 肱三头肌 | cable | — | 新手 | 沿用 | 模板初稿 | Seated_Cable_Shoulder_Press.md |
| 10 | `double_kettlebell_push_press` | 双侧壶铃借力推举 | Double Kettlebell Push Press | 三角肌 | 小腿、股四头肌、肱三头肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | Double_Kettlebell_Push_Press.md |
| 11 | `one_arm_kettlebell_push_press` | 单臂壶铃借力推举 | One-Arm Kettlebell Push Press | 三角肌 | 小腿、股四头肌、肱三头肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | One-Arm_Kettlebell_Push_Press.md |
| 12 | `handstand_push_up` | 倒立撑 | Handstand Push-Ups | 三角肌 | 肱三头肌 | bodyweight | — | 高手 | 沿用 | 需重写 | Handstand_Push-Ups.md |
| 13 | `bradford_press` | 布拉德福德推举 | Bradford/Rocky Presses | 三角肌 | 肱三头肌 | barbell | — | 新手 | 改名 | 需重写 | Bradford_Rocky_Presses.md |
| 14 | `shoulder_press_with_bands` | 弹力带肩推 | Shoulder Press - With Bands | 三角肌 | 肱三头肌 | band | — | 新手 | 改名 | 模板初稿 | Shoulder_Press_-_With_Bands.md |

### 水平拉（16）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `bent_over_barbell_row` | 杠铃俯身划船 | Bent Over Barbell Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | barbell | — | 新手 | 沿用 | 模板初稿 | Bent_Over_Barbell_Row.md |
| 2 | `bent_over_two_dumbbell_row` | 俯身双哑铃划船 | Bent Over Two-Dumbbell Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Bent_Over_Two-Dumbbell_Row.md |
| 3 | `one_arm_dumbbell_row` | 单臂哑铃划船 | One-Arm Dumbbell Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | One-Arm_Dumbbell_Row.md |
| 4 | `t_bar_row_with_handle` | T杠划船 | T-Bar Row with Handle | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌 | barbell | — | 新手 | 改名 | 模板初稿 | T-Bar_Row_with_Handle.md |
| 5 | `reverse_grip_bent_over_row` | 反握俯身划船 | Reverse Grip Bent-Over Rows | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | barbell | — | 进阶 | 沿用 | 模板初稿 | Reverse_Grip_Bent-Over_Rows.md |
| 6 | `seated_cable_row` | 坐姿绳索划船 | Seated Cable Rows | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | cable | — | 新手 | 沿用 | 模板初稿 | Seated_Cable_Rows.md |
| 7 | `leverage_iso_row` | 器械划船 | Leverage Iso Row | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束） | machine | — | 新手 | 改名 | 模板初稿 | Leverage_Iso_Row.md |
| 8 | `smith_machine_bent_over_row` | 史密斯机俯身划船 | Smith Machine Bent Over Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、三角肌 | machine | smith_machine | 新手 | 沿用 | 模板初稿 | Smith_Machine_Bent_Over_Row.md |
| 9 | `one_arm_kettlebell_row` | 单臂壶铃划船 | One-Arm Kettlebell Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | One-Arm_Kettlebell_Row.md |
| 10 | `inverted_row` | 仰卧划船 | Inverted Row | 中背（菱形肌/斜方肌中束） | 背阔肌 | bodyweight | bar | 新手 | 改名 | 模板初稿 | Inverted_Row.md |
| 11 | `suspension_row` | 悬吊划船 | Suspended Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌 | bodyweight | suspension_trainer | 新手 | 沿用 | 模板初稿 | Suspended_Row.md |
| 12 | `bent_over_two_dumbbell_row_neutral_grip` | 对握俯身双哑铃划船 | Bent Over Two-Dumbbell Row With Palms In | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌 | dumbbell | — | 新手 | 改名 | 模板初稿 | Bent_Over_Two-Dumbbell_Row_With_Palms_In.md |
| 13 | `alternating_kettlebell_row` | 交替壶铃划船 | Alternating Kettlebell Row | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌 | kettlebell | — | 进阶 | 沿用 | 模板初稿 | Alternating_Kettlebell_Row.md |
| 14 | `leverage_high_row` | 器械高位划船 | Leverage High Row | 中背（菱形肌/斜方肌中束） | 背阔肌 | machine | — | 新手 | 改名 | 模板初稿 | Leverage_High_Row.md |
| 15 | `cable_rear_delt_row` | 绳索后束划船 | Cable Rope Rear-Delt Rows | 三角肌 | 肱二头肌、中背（菱形肌/斜方肌中束） | cable | rope | 新手 | 改名 | 模板初稿 | Cable_Rope_Rear-Delt_Rows.md |
| 16 | `seated_one_arm_cable_row` | 坐姿单臂绳索划船 | Seated One-arm Cable Pulley Rows | 中背（菱形肌/斜方肌中束） | 肱二头肌、背阔肌、斜方肌 | cable | — | 进阶 | 改名 | 模板初稿 | Seated_One-arm_Cable_Pulley_Rows.md |

### 垂直拉（10）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pull_up` | 引体向上 | Pullups | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束） | bodyweight | pull_up_bar | 新手 | 沿用 | 模板初稿 | Pullups.md |
| 2 | `chin_up` | 反握引体向上 | Chin-Up | 背阔肌 | 肱二头肌、前臂、中背（菱形肌/斜方肌中束） | bodyweight | pull_up_bar | 新手 | 沿用 | 模板初稿 | Chin-Up.md |
| 3 | `wide_grip_lat_pulldown` | 宽握高位下拉 | Wide-Grip Lat Pulldown | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束）、三角肌 | cable | — | 新手 | 沿用 | 需重写 | Wide-Grip_Lat_Pulldown.md |
| 4 | `close_grip_front_lat_pulldown` | 窄握高位下拉 | Close-Grip Front Lat Pulldown | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束）、三角肌 | cable | — | 新手 | 沿用 | 需重写 | Close-Grip_Front_Lat_Pulldown.md |
| 5 | `v_bar_pulldown` | V把下拉 | V-Bar Pulldown | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束）、三角肌 | cable | v_bar | 进阶 | 改名 | 需重写 | V-Bar_Pulldown.md |
| 6 | `underhand_cable_pulldowns` | 反握绳索下拉 | Underhand Cable Pulldowns | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束）、三角肌 | cable | — | 新手 | 沿用 | 需重写 | Underhand_Cable_Pulldowns.md |
| 7 | `straight_arm_pulldown` | 直臂下拉 | Straight-Arm Pulldown | 背阔肌 | — | cable | — | 新手 | 沿用 | 需重写 | Straight-Arm_Pulldown.md |
| 8 | `band_assisted_pull_up` | 弹力带辅助引体向上 | Band Assisted Pull-Up | 背阔肌 | 腹肌、前臂、中背（菱形肌/斜方肌中束） | band | pull_up_bar | 新手 | 沿用 | 模板初稿 | Band_Assisted_Pull-Up.md |
| 9 | `weighted_pull_up` | 负重引体向上 | Weighted Pull Ups | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束） | bodyweight | — | 进阶 | 沿用 | 模板初稿 | Weighted_Pull_Ups.md |
| 10 | `one_arm_lat_pulldown` | 单臂高位下拉 | One Arm Lat Pulldown | 背阔肌 | 肱二头肌、中背（菱形肌/斜方肌中束） | cable | — | 新手 | 沿用 | 需重写 | One_Arm_Lat_Pulldown.md |

### 核心（16）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `plank` | 平板支撑 | Plank | 腹肌 | — | bodyweight | — | 新手 | 沿用 | 需重写 | Plank.md |
| 2 | `crunch` | 卷腹 | Crunches | 腹肌 | — | bodyweight | — | 新手 | 沿用 | 需重写 | Crunches.md |
| 3 | `sit_up` | 仰卧起坐 | Sit-Up | 腹肌 | — | bodyweight | — | 新手 | 沿用 | 需重写 | Sit-Up.md |
| 4 | `reverse_crunch` | 反向卷腹 | Reverse Crunch | 腹肌 | — | bodyweight | — | 新手 | 沿用 | 需重写 | Reverse_Crunch.md |
| 5 | `hanging_leg_raise` | 悬垂举腿 | Hanging Leg Raise | 腹肌 | — | bodyweight | — | 高手 | 沿用 | 模板初稿 | Hanging_Leg_Raise.md |
| 6 | `flat_bench_lying_leg_raise` | 仰卧举腿（平板凳） | Flat Bench Lying Leg Raise | 腹肌 | — | bodyweight | — | 新手 | 改名 | 模板初稿 | Flat_Bench_Lying_Leg_Raise.md |
| 7 | `ab_roller` | 健腹轮 | Ab Roller | 腹肌 | 三角肌 | bodyweight | ab_wheel | 进阶 | 改名 | 模板初稿 | Ab_Roller.md |
| 8 | `barbell_ab_rollout` | 杠铃腹肌滚轮 | Barbell Ab Rollout | 腹肌 | 下背/竖脊肌、三角肌 | barbell | ab_wheel | 进阶 | 沿用 | 需重写 | Barbell_Ab_Rollout.md |
| 9 | `cable_crunch` | 绳索卷腹 | Cable Crunch | 腹肌 | — | cable | — | 新手 | 沿用 | 需重写 | Cable_Crunch.md |
| 10 | `pallof_press` | 帕洛夫推举 | Pallof Press | 腹肌 | 胸大肌、三角肌、肱三头肌 | cable | — | 新手 | 沿用 | 模板初稿 | Pallof_Press.md |
| 11 | `russian_twist` | 俄罗斯转体 | Russian Twist | 腹肌 | 下背/竖脊肌 | bodyweight | — | 进阶 | 沿用 | 需重写 | Russian_Twist.md |
| 12 | `oblique_crunches` | 腹斜肌卷腹 | Oblique Crunches | 腹肌 | — | bodyweight | — | 新手 | 沿用 | 需重写 | Oblique_Crunches.md |
| 13 | `decline_crunch` | 下斜卷腹 | Decline Crunch | 腹肌 | — | bodyweight | bench | 进阶 | 沿用 | 模板初稿 | Decline_Crunch.md |
| 14 | `hanging_pike` | 悬垂屈体 | Hanging Pike | 腹肌 | — | bodyweight | — | 高手 | 沿用 | 模板初稿 | Hanging_Pike.md |
| 15 | `parallel_bar_knee_raise` | 双杠举腿 | Knee/Hip Raise On Parallel Bars | 腹肌 | — | bodyweight | parallel_bars | 新手 | 改名 | 模板初稿 | Knee_Hip_Raise_On_Parallel_Bars.md |
| 16 | `ab_crunch_machine` | 器械卷腹 | Ab Crunch Machine | 腹肌 | — | machine | — | 进阶 | 改名 | 需重写 | Ab_Crunch_Machine.md |

### 肱二头（14）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `barbell_curl` | 杠铃弯举 | Barbell Curl | 肱二头肌 | 前臂 | barbell | — | 新手 | 沿用 | 模板初稿 | Barbell_Curl.md |
| 2 | `ez_bar_curl` | 曲杆杠铃弯举 | EZ-Bar Curl | 肱二头肌 | — | ez_bar | — | 新手 | 沿用 | 模板初稿 | EZ-Bar_Curl.md |
| 3 | `dumbbell_curl` | 哑铃弯举 | Dumbbell Bicep Curl | 肱二头肌 | 前臂 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Dumbbell_Bicep_Curl.md |
| 4 | `hammer_curls` | 锤式弯举 | Hammer Curls | 肱二头肌 | — | dumbbell | — | 新手 | 沿用 | 模板初稿 | Hammer_Curls.md |
| 5 | `incline_dumbbell_curl` | 上斜哑铃弯举 | Incline Dumbbell Curl | 肱二头肌 | — | dumbbell | bench | 新手 | 沿用 | 模板初稿 | Incline_Dumbbell_Curl.md |
| 6 | `preacher_curl` | 牧师凳弯举 | Preacher Curl | 肱二头肌 | — | barbell | — | 新手 | 沿用 | 模板初稿 | Preacher_Curl.md |
| 7 | `cable_preacher_curl` | 绳索牧师凳弯举 | Cable Preacher Curl | 肱二头肌 | 前臂 | cable | — | 新手 | 沿用 | 模板初稿 | Cable_Preacher_Curl.md |
| 8 | `concentration_curl` | 集中弯举 | Concentration Curls | 肱二头肌 | 前臂 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Concentration_Curls.md |
| 9 | `spider_curl` | 蜘蛛弯举 | Spider Curl | 肱二头肌 | — | ez_bar | — | 新手 | 沿用 | 模板初稿 | Spider_Curl.md |
| 10 | `machine_curl` | 器械弯举 | Machine Bicep Curl | 肱二头肌 | — | machine | — | 新手 | 改名 | 模板初稿 | Machine_Bicep_Curl.md |
| 11 | `reverse_barbell_curl` | 反握杠铃弯举 | Reverse Barbell Curl | 肱二头肌 | 前臂 | barbell | — | 新手 | 沿用 | 模板初稿 | Reverse_Barbell_Curl.md |
| 12 | `zottman_curl` | 佐特曼弯举 | Zottman Curl | 肱二头肌 | 前臂 | dumbbell | — | 进阶 | 沿用 | 模板初稿 | Zottman_Curl.md |
| 13 | `standing_cable_curl` | 站姿绳索弯举 | Standing Biceps Cable Curl | 肱二头肌 | — | cable | — | 新手 | 改名 | 模板初稿 | Standing_Biceps_Cable_Curl.md |
| 14 | `cross_body_hammer_curl` | 横跨身体锤式弯举 | Cross Body Hammer Curl | 肱二头肌 | 前臂 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Cross_Body_Hammer_Curl.md |

### 肱三头（14）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `triceps_pushdown_rope` | 绳索三头下压（绳） | Triceps Pushdown - Rope Attachment | 肱三头肌 | — | cable | rope | 新手 | 改名 | 模板初稿 | Triceps_Pushdown_-_Rope_Attachment.md |
| 2 | `triceps_pushdown_v_bar` | 绳索三头下压（V把） | Triceps Pushdown - V-Bar Attachment | 肱三头肌 | — | cable | v_bar | 新手 | 改名 | 模板初稿 | Triceps_Pushdown_-_V-Bar_Attachment.md |
| 3 | `lying_triceps_press` | 仰卧臂屈伸（碎颅式） | Lying Triceps Press | 肱三头肌 | — | ez_bar | — | 进阶 | 沿用 | 模板初稿 | Lying_Triceps_Press.md |
| 4 | `ez_bar_skullcrusher` | 曲杆仰卧臂屈伸 | EZ-Bar Skullcrusher | 肱三头肌 | 前臂 | ez_bar | — | 新手 | 改名 | 模板初稿 | EZ-Bar_Skullcrusher.md |
| 5 | `bench_dips` | 凳上臂屈伸 | Bench Dips | 肱三头肌 | 胸大肌、三角肌 | bodyweight | bench, dip_bars | 新手 | 改名 | 需重写 | Bench_Dips.md |
| 6 | `triceps_dip` | 双杠臂屈伸（三头版） | Dips - Triceps Version | 肱三头肌 | 胸大肌、三角肌 | bodyweight | dip_bars | 新手 | 沿用 | 需重写 | Dips_-_Triceps_Version.md |
| 7 | `cable_overhead_triceps_extension` | 绳索过顶臂屈伸 | Cable Rope Overhead Triceps Extension | 肱三头肌 | — | cable | rope | 新手 | 改名 | 模板初稿 | Cable_Rope_Overhead_Triceps_Extension.md |
| 8 | `one_arm_dumbbell_triceps_extension` | 单臂哑铃臂屈伸 | Dumbbell One-Arm Triceps Extension | 肱三头肌 | — | dumbbell | — | 进阶 | 改名 | 模板初稿 | Dumbbell_One-Arm_Triceps_Extension.md |
| 9 | `seated_triceps_press` | 坐姿哑铃臂屈伸 | Seated Triceps Press | 肱三头肌 | — | dumbbell | — | 新手 | 改名 | 模板初稿 | Seated_Triceps_Press.md |
| 10 | `machine_triceps_extension` | 器械臂屈伸 | Machine Triceps Extension | 肱三头肌 | — | machine | — | 新手 | 改名 | 模板初稿 | Machine_Triceps_Extension.md |
| 11 | `tate_press` | 泰特推举 | Tate Press | 肱三头肌 | 胸大肌、三角肌 | dumbbell | — | 进阶 | 沿用 | 模板初稿 | Tate_Press.md |
| 12 | `jm_press` | JM 推举 | JM Press | 肱三头肌 | 胸大肌、三角肌 | barbell | — | 新手 | 沿用 | 需重写 | JM_Press.md |
| 13 | `reverse_grip_triceps_pushdown` | 反握三头下压 | Reverse Grip Triceps Pushdown | 肱三头肌 | — | cable | — | 新手 | 沿用 | 模板初稿 | Reverse_Grip_Triceps_Pushdown.md |
| 14 | `standing_overhead_triceps_extension` | 站姿过顶杠铃臂屈伸 | Standing Overhead Barbell Triceps Extension | 肱三头肌 | 三角肌 | barbell | — | 新手 | 改名 | 模板初稿 | Standing_Overhead_Barbell_Triceps_Extension.md |

### 肩部孤立（14）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `side_lateral_raise` | 哑铃侧平举 | Side Lateral Raise | 三角肌 | — | dumbbell | — | 新手 | 沿用 | 模板初稿 | Side_Lateral_Raise.md |
| 2 | `seated_side_lateral_raise` | 坐姿侧平举 | Seated Side Lateral Raise | 三角肌 | — | dumbbell | — | 新手 | 改名 | 模板初稿 | Seated_Side_Lateral_Raise.md |
| 3 | `front_dumbbell_raise` | 哑铃前平举 | Front Dumbbell Raise | 三角肌 | — | dumbbell | — | 新手 | 沿用 | 模板初稿 | Front_Dumbbell_Raise.md |
| 4 | `front_cable_raise` | 绳索前平举 | Front Cable Raise | 三角肌 | — | cable | — | 新手 | 改名 | 模板初稿 | Front_Cable_Raise.md |
| 5 | `reverse_fly` | 反向飞鸟（后束） | Reverse Flyes | 三角肌 | — | dumbbell | — | 新手 | 改名 | 模板初稿 | Reverse_Flyes.md |
| 6 | `reverse_machine_flyes` | 反向器械飞鸟 | Reverse Machine Flyes | 三角肌 | — | machine | — | 新手 | 沿用 | 模板初稿 | Reverse_Machine_Flyes.md |
| 7 | `cable_rear_delt_fly` | 绳索后束飞鸟 | Cable Rear Delt Fly | 三角肌 | — | cable | — | 新手 | 改名 | 模板初稿 | Cable_Rear_Delt_Fly.md |
| 8 | `face_pull` | 面拉 | Face Pull | 三角肌 | 中背（菱形肌/斜方肌中束） | cable | rope | 进阶 | 沿用 | 模板初稿 | Face_Pull.md |
| 9 | `dumbbell_shrug` | 哑铃耸肩 | Dumbbell Shrug | 斜方肌 | — | dumbbell | — | 新手 | 沿用 | 模板初稿 | Dumbbell_Shrug.md |
| 10 | `barbell_shrug` | 杠铃耸肩 | Barbell Shrug | 斜方肌 | — | barbell | — | 新手 | 沿用 | 模板初稿 | Barbell_Shrug.md |
| 11 | `cable_shrug` | 绳索耸肩 | Cable Shrugs | 斜方肌 | — | cable | — | 新手 | 沿用 | 模板初稿 | Cable_Shrugs.md |
| 12 | `standing_dumbbell_upright_row` | 站姿哑铃直立划船 | Standing Dumbbell Upright Row | 斜方肌 | 肱二头肌、三角肌 | dumbbell | — | 新手 | 沿用 | 模板初稿 | Standing_Dumbbell_Upright_Row.md |
| 13 | `barbell_rear_delt_row` | 杠铃后束划船 | Barbell Rear Delt Row | 三角肌 | 肱二头肌、背阔肌、中背（菱形肌/斜方肌中束） | barbell | — | 新手 | 改名 | 模板初稿 | Barbell_Rear_Delt_Row.md |
| 14 | `band_lateral_raise` | 弹力带侧平举 | Lateral Raise - With Bands | 三角肌 | — | band | — | 新手 | 改名 | 模板初稿 | Lateral_Raise_-_With_Bands.md |

### 腿部孤立（14）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `leg_extension` | 坐姿腿屈伸 | Leg Extensions | 股四头肌 | — | machine | leg_extension_machine | 新手 | 沿用 | 模板初稿 | Leg_Extensions.md |
| 2 | `seated_leg_curl` | 坐姿腿弯举 | Seated Leg Curl | 腘绳肌 | — | machine | leg_curl_machine | 新手 | 沿用 | 模板初稿 | Seated_Leg_Curl.md |
| 3 | `lying_leg_curl` | 俯卧腿弯举 | Lying Leg Curls | 腘绳肌 | — | machine | leg_curl_machine | 新手 | 沿用 | 模板初稿 | Lying_Leg_Curls.md |
| 4 | `standing_leg_curl` | 站姿腿弯举 | Standing Leg Curl | 腘绳肌 | — | machine | leg_curl_machine | 新手 | 沿用 | 模板初稿 | Standing_Leg_Curl.md |
| 5 | `reverse_hyperextension` | 反向山羊挺身 | Reverse Hyperextension | 腘绳肌 | 小腿、臀大肌 | machine | reverse_hyper_machine | 进阶 | 沿用 | 模板初稿 | Reverse_Hyperextension.md |
| 6 | `standing_calf_raise` | 站姿提踵 | Standing Calf Raises | 小腿 | — | machine | calf_machine | 新手 | 沿用 | 模板初稿 | Standing_Calf_Raises.md |
| 7 | `seated_calf_raise` | 坐姿提踵 | Seated Calf Raise | 小腿 | — | machine | calf_machine | 新手 | 沿用 | 模板初稿 | Seated_Calf_Raise.md |
| 8 | `donkey_calf_raise` | 驴式提踵 | Donkey Calf Raises | 小腿 | — | machine | calf_machine | 进阶 | 沿用 | 模板初稿 | Donkey_Calf_Raises.md |
| 9 | `smith_machine_calf_raise` | 史密斯机提踵 | Smith Machine Calf Raise | 小腿 | — | machine | smith_machine, calf_machine | 新手 | 沿用 | 模板初稿 | Smith_Machine_Calf_Raise.md |
| 10 | `glute_kickback` | 跪姿后踢腿 | Glute Kickback | 臀大肌 | 腘绳肌 | bodyweight | — | 新手 | 沿用 | 模板初稿 | Glute_Kickback.md |
| 11 | `thigh_abductor` | 大腿外展 | Thigh Abductor | 外展肌 | 臀大肌 | machine | — | 新手 | 改名 | 模板初稿 | Thigh_Abductor.md |
| 12 | `thigh_adductor` | 大腿内收 | Thigh Adductor | 内收肌 | 臀大肌、腘绳肌 | machine | — | 新手 | 改名 | 模板初稿 | Thigh_Adductor.md |
| 13 | `band_hip_extension` | 弹力带髋伸展 | Hip Extension with Bands | 臀大肌 | 腘绳肌 | band | — | 新手 | 沿用 | 模板初稿 | Hip_Extension_with_Bands.md |
| 14 | `leg_press_calf_raise` | 腿举机提踵 | Calf Press On The Leg Press Machine | 小腿 | — | machine | leg_press_machine, calf_machine | 新手 | 改名 | 模板初稿 | Calf_Press_On_The_Leg_Press_Machine.md |

### 有氧（8）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `bicycling` | 骑行 | Bicycling | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | bike | 新手 | 沿用 | 需重写 | Bicycling.md |
| 2 | `stationary_bike` | 固定单车 | Bicycling, Stationary | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | stationary_bike | 新手 | 改名 | 需重写 | Bicycling_Stationary.md |
| 3 | `elliptical_trainer` | 椭圆机 | Elliptical Trainer | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | elliptical | 进阶 | 改名 | 需重写 | Elliptical_Trainer.md |
| 4 | `stationary_rower` | 划船机 | Rowing, Stationary | 股四头肌 | 肱二头肌、小腿、臀大肌、腘绳肌、下背/竖脊肌、中背（菱形肌/斜方肌中束） | cardio_machine | rower | 进阶 | 改名 | 需重写 | Rowing_Stationary.md |
| 5 | `rope_jumping` | 跳绳 | Rope Jumping | 股四头肌 | 小腿、腘绳肌 | cardio_machine | jump_rope | 进阶 | 沿用 | 需重写 | Rope_Jumping.md |
| 6 | `stairmaster` | 登山机 | Stairmaster | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | stair_climber | 进阶 | 沿用 | 需重写 | Stairmaster.md |
| 7 | `treadmill_walk` | 跑步机行走 | Walking, Treadmill | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | treadmill | 新手 | 改名 | 需重写 | Walking_Treadmill.md |
| 8 | `treadmill_run` | 跑步机跑步 | Running, Treadmill | 股四头肌 | 小腿、臀大肌、腘绳肌 | cardio_machine | treadmill | 新手 | 改名 | 需重写 | Running_Treadmill.md |

### 灵活性（8）

| # | ID | 中文名 | English | 主要肌群 | 协同肌群 | 器械 category | 附加 items | 难度 | 名称 | 内容 | guide 页 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `hamstring_stretch` | 腘绳肌拉伸 | Hamstring Stretch | 腘绳肌 | — | bodyweight | — | 新手 | 沿用 | 模板初稿 | Hamstring_Stretch.md |
| 2 | `quad_stretch` | 股四头肌拉伸 | Quad Stretch | 股四头肌 | — | bodyweight | — | 进阶 | 沿用 | 模板初稿 | Quad_Stretch.md |
| 3 | `wall_calf_stretch` | 靠墙小腿拉伸 | Calf Stretch Hands Against Wall | 小腿 | — | bodyweight | — | 新手 | 改名 | 模板初稿 | Calf_Stretch_Hands_Against_Wall.md |
| 4 | `chest_shoulder_stretch` | 胸肌与肩前侧拉伸 | Chest And Front Of Shoulder Stretch | 胸大肌 | 三角肌 | bodyweight | — | 新手 | 改名 | 模板初稿 | Chest_And_Front_Of_Shoulder_Stretch.md |
| 5 | `overhead_lat_stretch` | 过顶背阔肌拉伸 | Overhead Lat | 背阔肌 | 肱三头肌 | bodyweight | — | 高手 | 沿用 | 模板初稿 | Overhead_Lat.md |
| 6 | `kneeling_hip_flexor_stretch` | 跪姿髋屈肌拉伸 | Kneeling Hip Flexor | 股四头肌 | 股四头肌 | bodyweight | — | 新手 | 沿用 | 模板初稿 | Kneeling_Hip_Flexor.md |
| 7 | `cat_stretch` | 猫式伸展 | Cat Stretch | 下背/竖脊肌 | 中背（菱形肌/斜方肌中束）、斜方肌 | bodyweight | — | 新手 | 沿用 | 需重写 | Cat_Stretch.md |
| 8 | `worlds_greatest_stretch` | 世界最佳拉伸 | World's Greatest Stretch | 腘绳肌 | 小腿、臀大肌、股四头肌 | bodyweight | — | 进阶 | 沿用 | 模板初稿 | Worlds_Greatest_Stretch.md |

## 附录 A：改名对照（66 条）

| ID | seed 名 | canonical 名 |
|---|---|---|
| `front_squat` | 前侧深蹲（翻站握法） | 前蹲 |
| `box_squat` | 跳箱深蹲 | 箱式深蹲 |
| `leg_press` | 倒蹬机腿举 | 腿举 |
| `narrow_stance_leg_press` | 窄距站距腿举（倒蹬） | 窄距腿举 |
| `kettlebell_pistol_squat` | 壶铃手枪蹲 | 壶铃手枪深蹲 |
| `weighted_sissy_squat` | 负重西西里深蹲 | 负重西斯深蹲 |
| `plie_dumbbell_squat` | 芭蕾式哑铃深蹲 | 相扑哑铃深蹲 |
| `good_morning` | 早安式体前屈 | 早安式 |
| `band_good_morning` | 弹力带早安式体前屈 | 弹力带早安式 |
| `pull_through` | 拉 | 绳索胯下后拉 |
| `rack_pulls` | 架上拉 | 架上硬拉 |
| `glute_ham_raise` | 臀腘绳肌上举 | 臀腘绳肌上举（器械） |
| `dumbbell_rear_lunge` | 哑铃后侧箭步蹲 | 哑铃后撤箭步蹲 |
| `step_up_knee_raise` | 登阶（举膝） | 登阶提膝 |
| `barbell_bench_press` | 杠铃平板卧推（中握距） | 杠铃卧推 |
| `incline_barbell_bench_press` | 杠铃上斜卧推（中握距） | 上斜杠铃卧推 |
| `dumbbell_bench_press` | 哑铃平板卧推 | 哑铃卧推 |
| `dumbbell_bench_press_with_neutral_grip` | 哑铃卧推（对握） | 哑铃对握卧推 |
| `flat_bench_cable_fly` | 平板卧凳绳索飞鸟 | 平板绳索飞鸟 |
| `leverage_chest_press` | 杠杆式胸推 | 器械推胸 |
| `standing_military_press` | 站姿军推 | 站姿杠铃推举 |
| `seated_barbell_military_press` | 坐姿杠铃军推 | 坐姿杠铃推举 |
| `dumbbell_one_arm_shoulder_press` | 哑铃单臂肩推 | 单臂哑铃肩推 |
| `smith_machine_shoulder_press` | 史密斯机过顶肩推 | 史密斯机肩推 |
| `leverage_shoulder_press` | 杠杆式肩推 | 器械肩推 |
| `bradford_press` | 布拉德福洛基推举 | 布拉德福德推举 |
| `shoulder_press_with_bands` | 肩推（弹力带） | 弹力带肩推 |
| `t_bar_row_with_handle` | T 杠划船 | T杠划船 |
| `leverage_iso_row` | 杠杆式静力划船 | 器械划船 |
| `inverted_row` | 反式划船 | 仰卧划船 |
| `bent_over_two_dumbbell_row_neutral_grip` | 俯身双哑铃划船（掌心） | 对握俯身双哑铃划船 |
| `leverage_high_row` | 杠杆式高位划船 | 器械高位划船 |
| `cable_rear_delt_row` | 绳索后侧三角肌划船 | 绳索后束划船 |
| `seated_one_arm_cable_row` | 坐姿单臂绳索滑轮划船 | 坐姿单臂绳索划船 |
| `v_bar_pulldown` | V 型把手下拉 | V把下拉 |
| `flat_bench_lying_leg_raise` | 平板卧凳仰卧举腿 | 仰卧举腿（平板凳） |
| `ab_roller` | 腹肌滚轮 | 健腹轮 |
| `parallel_bar_knee_raise` | 膝髋上举（双杠） | 双杠举腿 |
| `ab_crunch_machine` | 腹肌卷腹器械 | 器械卷腹 |
| `machine_curl` | 器械肱二头肌弯举 | 器械弯举 |
| `standing_cable_curl` | 站姿肱二头肌绳索弯举 | 站姿绳索弯举 |
| `triceps_pushdown_rope` | 三头下压（绳索把手） | 绳索三头下压（绳） |
| `triceps_pushdown_v_bar` | 三头下压（V 型把手把手） | 绳索三头下压（V把） |
| `ez_bar_skullcrusher` | 曲杆杠铃碎颅式臂屈伸 | 曲杆仰卧臂屈伸 |
| `bench_dips` | 凳上反屈伸 | 凳上臂屈伸 |
| `cable_overhead_triceps_extension` | 绳索过顶肱三头肌臂屈伸 | 绳索过顶臂屈伸 |
| `one_arm_dumbbell_triceps_extension` | 哑铃单臂肱三头肌臂屈伸 | 单臂哑铃臂屈伸 |
| `seated_triceps_press` | 坐姿肱三头肌推举 | 坐姿哑铃臂屈伸 |
| `machine_triceps_extension` | 器械肱三头肌臂屈伸 | 器械臂屈伸 |
| `standing_overhead_triceps_extension` | 站姿过顶杠铃肱三头肌臂屈伸 | 站姿过顶杠铃臂屈伸 |
| `seated_side_lateral_raise` | 坐姿侧平举上举 | 坐姿侧平举 |
| `front_cable_raise` | 前侧绳索上举 | 绳索前平举 |
| `reverse_fly` | 反向飞鸟（三角肌后束） | 反向飞鸟（后束） |
| `cable_rear_delt_fly` | 绳索三角肌后束飞鸟 | 绳索后束飞鸟 |
| `barbell_rear_delt_row` | 杠铃三角肌后束划船 | 杠铃后束划船 |
| `band_lateral_raise` | 侧平举（弹力带） | 弹力带侧平举 |
| `thigh_abductor` | 大腿外展肌 | 大腿外展 |
| `thigh_adductor` | 大腿内收肌 | 大腿内收 |
| `leg_press_calf_raise` | 腿举（倒蹬）器械器械提踵 | 腿举机提踵 |
| `stationary_bike` | 骑行固定式 | 固定单车 |
| `elliptical_trainer` | 椭圆机训练器 | 椭圆机 |
| `stationary_rower` | 划船机固定式 | 划船机 |
| `treadmill_walk` | 行走跑步机 | 跑步机行走 |
| `treadmill_run` | 跑步跑步机 | 跑步机跑步 |
| `wall_calf_stretch` | 小腿拉伸双手抵住靠墙 | 靠墙小腿拉伸 |
| `chest_shoulder_stretch` | 胸前侧肩拉伸 | 胸肌与肩前侧拉伸 |

## 附录 B：要点/错误优先重写（49 条）

| 中文名 | English |
|---|---|
| 杠铃深蹲 | Barbell Squat |
| 前蹲 | Front Squat (Clean Grip) |
| 杠铃哈克深蹲 | Barbell Hack Squat |
| 箱式深蹲 | Box Squat |
| 泽奇深蹲 | Zercher Squats |
| 负重西斯深蹲 | Weighted Sissy Squat |
| 杰斐逊深蹲 | Jefferson Squats |
| 杠铃硬拉 | Barbell Deadlift |
| 罗马尼亚硬拉 | Romanian Deadlift |
| 相扑硬拉 | Sumo Deadlift |
| 六角杠铃硬拉 | Trap Bar Deadlift |
| 直腿杠铃硬拉 | Stiff-Legged Barbell Deadlift |
| 早安式 | Good Morning |
| 垫高硬拉 | Deficit Deadlift |
| 架上硬拉 | Rack Pulls |
| 杠铃行走箭步蹲 | Barbell Walking Lunge |
| 自重行走箭步蹲 | Bodyweight Walking Lunge |
| 窄握杠铃卧推 | Close-Grip Barbell Bench Press |
| 俯卧撑 | Pushups |
| 双杠臂屈伸（胸肌版） | Dips - Chest Version |
| 倒立撑 | Handstand Push-Ups |
| 布拉德福德推举 | Bradford/Rocky Presses |
| 宽握高位下拉 | Wide-Grip Lat Pulldown |
| 窄握高位下拉 | Close-Grip Front Lat Pulldown |
| V把下拉 | V-Bar Pulldown |
| 反握绳索下拉 | Underhand Cable Pulldowns |
| 直臂下拉 | Straight-Arm Pulldown |
| 单臂高位下拉 | One Arm Lat Pulldown |
| 平板支撑 | Plank |
| 卷腹 | Crunches |
| 仰卧起坐 | Sit-Up |
| 反向卷腹 | Reverse Crunch |
| 杠铃腹肌滚轮 | Barbell Ab Rollout |
| 绳索卷腹 | Cable Crunch |
| 俄罗斯转体 | Russian Twist |
| 腹斜肌卷腹 | Oblique Crunches |
| 器械卷腹 | Ab Crunch Machine |
| 凳上臂屈伸 | Bench Dips |
| 双杠臂屈伸（三头版） | Dips - Triceps Version |
| JM 推举 | JM Press |
| 骑行 | Bicycling |
| 固定单车 | Bicycling, Stationary |
| 椭圆机 | Elliptical Trainer |
| 划船机 | Rowing, Stationary |
| 跳绳 | Rope Jumping |
| 登山机 | Stairmaster |
| 跑步机行走 | Walking, Treadmill |
| 跑步机跑步 | Running, Treadmill |
| 猫式伸展 | Cat Stretch |

## 附录 C：别名（仅列出有条目的项）

| ID | 中文别名 | 英文别名 |
|---|---|---|
| `barbell_squat` | 深蹲 | Back Squat |
| `front_squat` | 前侧深蹲（翻站握法） | Front Squat |
| `box_squat` | 跳箱深蹲 | — |
| `leg_press` | 倒蹬机腿举、倒蹬 | — |
| `narrow_stance_leg_press` | 窄距站距腿举（倒蹬） | — |
| `kettlebell_pistol_squat` | 壶铃手枪蹲 | — |
| `weighted_sissy_squat` | 负重西西里深蹲 | — |
| `plie_dumbbell_squat` | 芭蕾式哑铃深蹲 | — |
| `barbell_deadlift` | 硬拉 | Conventional Deadlift |
| `romanian_deadlift` | RDL、直腿硬拉 | RDL |
| `good_morning` | 早安式体前屈 | — |
| `band_good_morning` | 弹力带早安式体前屈 | — |
| `pull_through` | 拉 | — |
| `rack_pulls` | 架上拉 | — |
| `glute_ham_raise` | 臀腘绳肌上举 | — |
| `dumbbell_rear_lunge` | 哑铃后侧箭步蹲 | — |
| `step_up_knee_raise` | 登阶（举膝） | — |
| `barbell_bench_press` | 杠铃平板卧推（中握距）、卧推、平板卧推 | Bench Press, Flat Bench Press, Barbell Bench Press |
| `incline_barbell_bench_press` | 杠铃上斜卧推（中握距） | Barbell Incline Bench Press |
| `dumbbell_bench_press` | 哑铃平板卧推 | — |
| `dumbbell_bench_press_with_neutral_grip` | 哑铃卧推（对握） | — |
| `butterfly` | 蝴蝶机 | — |
| `flat_bench_cable_fly` | 平板卧凳绳索飞鸟 | — |
| `leverage_chest_press` | 杠杆式胸推 | — |
| `push_up` | — | Push-ups |
| `chest_dip` | 双杠臂屈伸 | Chest Dip |
| `standing_military_press` | 站姿军推、站姿推举、军推 | Overhead Press, OHP, Military Press |
| `seated_barbell_military_press` | 坐姿杠铃军推 | — |
| `dumbbell_one_arm_shoulder_press` | 哑铃单臂肩推 | — |
| `smith_machine_shoulder_press` | 史密斯机过顶肩推 | — |
| `leverage_shoulder_press` | 杠杆式肩推 | — |
| `bradford_press` | 布拉德福洛基推举 | — |
| `shoulder_press_with_bands` | 肩推（弹力带） | — |
| `bent_over_barbell_row` | 俯身划船 | — |
| `t_bar_row_with_handle` | T 杠划船 | — |
| `leverage_iso_row` | 杠杆式静力划船 | — |
| `inverted_row` | 反式划船 | — |
| `bent_over_two_dumbbell_row_neutral_grip` | 俯身双哑铃划船（掌心） | — |
| `leverage_high_row` | 杠杆式高位划船 | — |
| `cable_rear_delt_row` | 绳索后侧三角肌划船 | — |
| `seated_one_arm_cable_row` | 坐姿单臂绳索滑轮划船 | — |
| `pull_up` | 引体 | Pull-ups |
| `chin_up` | 反手引体 | Chinups, Chin-ups |
| `wide_grip_lat_pulldown` | 高位下拉 | Lat Pulldown |
| `v_bar_pulldown` | V 型把手下拉 | — |
| `flat_bench_lying_leg_raise` | 平板卧凳仰卧举腿 | — |
| `ab_roller` | 腹肌滚轮 | — |
| `parallel_bar_knee_raise` | 膝髋上举（双杠） | — |
| `ab_crunch_machine` | 腹肌卷腹器械 | — |
| `barbell_curl` | 二头弯举 | — |
| `machine_curl` | 器械肱二头肌弯举 | — |
| `standing_cable_curl` | 站姿肱二头肌绳索弯举 | — |
| `triceps_pushdown_rope` | 三头下压（绳索把手）、三头下压 | Rope Pushdown |
| `triceps_pushdown_v_bar` | 三头下压（V 型把手把手） | V-Bar Pushdown |
| `ez_bar_skullcrusher` | 曲杆杠铃碎颅式臂屈伸 | — |
| `bench_dips` | 凳上反屈伸 | — |
| `triceps_dip` | 双杠臂屈伸 | Triceps Dip |
| `cable_overhead_triceps_extension` | 绳索过顶肱三头肌臂屈伸 | — |
| `one_arm_dumbbell_triceps_extension` | 哑铃单臂肱三头肌臂屈伸 | — |
| `seated_triceps_press` | 坐姿肱三头肌推举 | — |
| `machine_triceps_extension` | 器械肱三头肌臂屈伸 | — |
| `standing_overhead_triceps_extension` | 站姿过顶杠铃肱三头肌臂屈伸 | — |
| `side_lateral_raise` | 侧平举 | — |
| `seated_side_lateral_raise` | 坐姿侧平举上举 | — |
| `front_cable_raise` | 前侧绳索上举 | — |
| `reverse_fly` | 反向飞鸟（三角肌后束） | — |
| `cable_rear_delt_fly` | 绳索三角肌后束飞鸟 | — |
| `barbell_rear_delt_row` | 杠铃三角肌后束划船 | — |
| `band_lateral_raise` | 侧平举（弹力带） | — |
| `thigh_abductor` | 大腿外展肌 | — |
| `thigh_adductor` | 大腿内收肌 | — |
| `leg_press_calf_raise` | 腿举（倒蹬）器械器械提踵 | — |
| `stationary_bike` | 骑行固定式 | — |
| `elliptical_trainer` | 椭圆机训练器 | — |
| `stationary_rower` | 划船机固定式 | — |
| `treadmill_walk` | 行走跑步机 | — |
| `treadmill_run` | 跑步跑步机 | — |
| `wall_calf_stretch` | 小腿拉伸双手抵住靠墙 | — |
| `chest_shoulder_stretch` | 胸前侧肩拉伸 | — |

## 附录 D：例外与待确认

1. free-exercise-db 有中文缺口的 3 条（Kettlebell Halo、Kettlebell Halo with Overhead Extension、Kettlebell Overhead Triceps Extension）不在 v1；后续补中文名。
2. 有氧/灵活性种子只收 8+8，用于 `session_type` 覆盖；中文要领模板风险高，建议自写。
3. 本表 `primary/secondary` 为继承值，未做训练学复核；`equipment items` 为启发式初版。
4. `chest_dip` 与 `triceps_dip` 保留为两条，关系字段记 `variant_of`；如后续要合并，再改数据不动 ID。
5. 本表没有写入图片/视频；媒体仍按此前结论 v1 不做。
