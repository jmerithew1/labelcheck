/** Client-side downscale before upload: ≤1568px long edge (vision models see
 *  nothing extra above this; phone photos upload 10× faster downscaled —
 *  upload bandwidth was a measured batch bottleneck on prior projects). */
export async function downscaleImage(file: File, maxEdge = 1568): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // unreadable as image — let the server reject loudly
  const { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return file;
  const scale = maxEdge / longEdge;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}
