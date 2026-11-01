process.on("message", (message) => {
  if (message?.type !== "mixer_frame") return;
  process.send?.(message);
});
