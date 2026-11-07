import { isAbsolute } from "node:path";
import { z } from "zod";

const pathsSchema = z
  .array(z.string().min(1).refine(isAbsolute, "Expected an absolute file path"))
  .min(1)
  .max(1000);
export async function moveFilesToTrash(
  input: unknown,
  trashItem: (path: string) => Promise<void>,
): Promise<void> {
  const paths = pathsSchema.parse(input);
  for (const path of paths) await trashItem(path);
}
