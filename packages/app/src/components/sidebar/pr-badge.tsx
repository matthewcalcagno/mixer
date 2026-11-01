import { useCallback, useState } from "react";
import {
  Text,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ExternalLink } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { PrHint } from "@/git/use-pr-status-query";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedExternalLink = withUnistyles(ExternalLink);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export function PrBadge({ hint, style }: { hint: PrHint; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      prBadgeStyles.badge,
      style,
      pressed && prBadgeStyles.badgePressed,
    ],
    [style],
  );
  const textStyle = isHovered
    ? [prBadgeStyles.text, prBadgeStyles.textHovered]
    : prBadgeStyles.text;
  const presentation = getForgePresentation(normalizeForge(hint.forge));
  return (
    <PressHighlight
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={pressableStyle}
    >
      {isHovered ? (
        <ThemedExternalLink size={12} uniProps={foregroundColorMapping} />
      ) : (
        <PullRequestStateIcon state={hint.state} size={12} />
      )}
      <Text style={textStyle} numberOfLines={1}>
        {hint.number}
      </Text>
    </PressHighlight>
  );
}

const prBadgeStyles = StyleSheet.create((theme) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: 2 },
  badgePressed: { opacity: 0.82 },
  text: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  textHovered: { color: theme.colors.foreground },
}));
