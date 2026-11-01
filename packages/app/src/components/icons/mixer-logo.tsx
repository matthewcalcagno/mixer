import { useMemo } from "react";
import { Image } from "react-native";

interface MixerLogoProps {
  size?: number;
  color?: string;
}

export function MixerLogo({ size = 64 }: MixerLogoProps) {
  const style = useMemo(() => ({ width: size, height: size }), [size]);
  return (
    <Image
      source={require("../../../assets/images/icon.png")}
      style={style}
      resizeMode="contain"
      accessible={false}
    />
  );
}
