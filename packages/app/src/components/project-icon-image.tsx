import { useMemo, type ReactElement } from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

export interface ProjectIconImageProps {
  dataUri: string;
  fallback: ReactElement;
  style: StyleProp<ImageStyle>;
}

export function ProjectIconImage({ dataUri, style }: ProjectIconImageProps) {
  const source = useMemo(() => ({ uri: dataUri }), [dataUri]);
  return <Image source={source} style={style} />;
}
