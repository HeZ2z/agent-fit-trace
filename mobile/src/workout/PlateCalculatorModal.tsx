import {
  BAR_WEIGHTS_KG,
  DEFAULT_BAR_WEIGHT_KG,
  computePlateBreakdown,
} from "@agent-fit-trace/core";
import type { PlateBreakdown } from "@agent-fit-trace/core";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { useI18n } from "@/i18n";
import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";
import { Banner, Body, Button, Card, Chip, Field, Title } from "@/ui";

/**
 * Display-only plate calculator for the barbell lifts.
 *
 * The target weight and bar choice are local component state: nothing here is
 * part of the session draft and nothing is persisted. The per-side breakdown
 * itself is shared domain math from `@agent-fit-trace/core`, so the web dialog
 * and this modal cannot disagree about plates, loaded weight or the remainder.
 */
type PlateCalculation =
  | { ok: true; breakdown: PlateBreakdown }
  | { ok: false; message: string };

const copy = {
  title: "Plate calculator",
  target: "Target weight (kg)",
  bar: "Bar weight (kg)",
  perSide: "Plates per side",
  loaded: "Loaded weight",
  remainder: "Remainder",
  invalidTarget: "Enter a valid target weight.",
  belowBar: "Target weight must be at least the bar weight.",
  close: "Close",
} as const;

const EMPTY_PLATES = "—";

/**
 * Compute a per-side load for a typed target.
 *
 * Blank and non-numeric input is "not a weight yet"; a finite target lighter
 * than the bar is rejected by core's `RangeError`, which maps to its own
 * message. Any other error is a programming bug and propagates.
 */
function calculatePlates(targetRaw: string, barKg: number): PlateCalculation {
  const trimmed = targetRaw.trim();
  if (trimmed === "") {
    return { ok: false, message: copy.invalidTarget };
  }
  const targetKg = Number(trimmed);
  if (!Number.isFinite(targetKg) || targetKg <= 0) {
    return { ok: false, message: copy.invalidTarget };
  }
  try {
    return { ok: true, breakdown: computePlateBreakdown(targetKg, { barKg }) };
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: false, message: copy.belowBar };
    }
    throw error;
  }
}

/** Trim a kilogram amount to at most two decimals for display. */
function formatKg(value: number): string {
  return String(Math.round(value * 100) / 100);
}

interface PlateCalculatorModalProps {
  visible: boolean;
  onClose: () => void;
}

export function PlateCalculatorModal({ visible, onClose }: PlateCalculatorModalProps) {
  const { t } = useI18n();
  const { tokens } = useSkin();
  const { palette } = tokens;

  const [target, setTarget] = useState("");
  const [barKg, setBarKg] = useState<number>(DEFAULT_BAR_WEIGHT_KG);
  const result = calculatePlates(target, barKg);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      transparent
      visible={visible}>
      {/* The scrim is a sibling behind the dialog, so fields keep their own
          touch handling and a tap outside closes without a responder dance. */}
      <View style={styles.root}>
        <Pressable accessible={false} onPress={onClose} style={styles.scrim} />
        <View pointerEvents="box-none" style={styles.dialogWrap}>
          <Card
            accessibilityViewIsModal
            style={[styles.dialog, { backgroundColor: palette.surface }]}
            testID="plate-modal">
            <Title>{t(copy.title)}</Title>

            <Field
              autoFocus
              keyboardType="decimal-pad"
              label={t(copy.target)}
              onChangeText={setTarget}
              testID="plate-target-weight"
              value={target}
            />

            <View style={styles.barBlock}>
              <Text style={[styles.barLabel, { color: palette.muted }]}>{t(copy.bar)}</Text>
              <View style={styles.chips}>
                {BAR_WEIGHTS_KG.map((weight) => (
                  <Chip
                    key={weight}
                    label={`${weight} kg`}
                    onPress={() => setBarKg(weight)}
                    selected={barKg === weight}
                    testID={`plate-bar-${weight}`}
                  />
                ))}
              </View>
            </View>

            {result.ok ? (
              <>
                <Body style={styles.sectionLabel} tone="default">
                  {t(copy.perSide)}
                </Body>
                <View style={styles.plateList} testID="plate-list">
                  {result.breakdown.plates.length === 0 ? (
                    <Body testID="plate-empty">{EMPTY_PLATES}</Body>
                  ) : (
                    result.breakdown.plates.map((plate) => (
                      <Text
                        key={plate.plateKg}
                        style={[styles.plateRow, { color: palette.fg }]}
                        testID={`plate-row-${plate.plateKg}`}>
                        {plate.plateKg} kg × {plate.count}
                      </Text>
                    ))
                  )}
                </View>
                <Body testID="plate-loaded" tone="default">
                  {t(copy.loaded)}: {formatKg(result.breakdown.loadedKg)} kg
                </Body>
                <Body testID="plate-remainder" tone="muted">
                  {t(copy.remainder)}: {formatKg(result.breakdown.remainderKg)} kg
                </Body>
              </>
            ) : (
              <Banner message={t(result.message)} testID="plate-error" tone="danger" />
            )}

            <Button label={t(copy.close)} onPress={onClose} testID="plate-close" />
          </Card>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", padding: SPACING[4] },
  // The palette foreground at 45%: both skins dim the underlying screen without
  // introducing a second overlay token.
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(11, 31, 92, 0.45)",
  },
  dialogWrap: { width: "100%", alignItems: "center" },
  dialog: {
    width: "100%",
    maxWidth: 440,
    gap: SPACING[3],
  },
  barBlock: { gap: SPACING[2] },
  barLabel: {
    ...TYPOGRAPHY.micro,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] },
  sectionLabel: { fontWeight: "700" },
  plateList: { gap: SPACING[1] },
  plateRow: { ...TYPOGRAPHY.bodyText, fontWeight: "700" },
});
