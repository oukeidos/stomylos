// Check the pixels actually registered with the Linux window manager.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function checkWindowIcon(application, page) {
  const window = await application.browserWindow(page);
  const id = await window.evaluate(win => win.getNativeWindowHandle().readUInt32LE(0));
  await window.dispose();
  const source = await application.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path);
    return { size: image.getSize(), pixels: image.toBitmap().toString('base64') };
  }, resolve('assets/icon.png'));
  const expected = Buffer.from(source.pixels, 'base64');
  const property = execFileSync('xprop', ['-id', `0x${id.toString(16)}`, '-len', '8388608', '-f', '_NET_WM_ICON', '32c', '-notype', '_NET_WM_ICON'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const values = property.slice(property.indexOf('=') + 1).match(/\d+/g)?.map(Number) ?? [];
  assert.ok(values.length > 2, 'Window manager received an icon');
  let matched = false;
  for (let offset = 0; offset < values.length;) {
    const width = values[offset++], height = values[offset++];
    assert.ok(width > 0 && height > 0 && offset + width * height <= values.length, `Invalid icon property: ${width}x${height}, offset ${offset}, ${values.length} values; ${property.slice(0, 200)}`);
    if (width === source.size.width && height === source.size.height) {
      const actual = Buffer.alloc(width * height * 4);
      for (let n = 0; n < width * height; n++) actual.writeUInt32LE(values[offset + n] >>> 0, n * 4);
      // X11 stores straight ARGB; nativeImage.toBitmap uses premultiplied BGRA.
      // Normalize alpha and allow one rounding unit only on translucent edges.
      let mismatches = 0;
      for (let pixel = 0; pixel < actual.length; pixel += 4) {
        const alpha = actual[pixel + 3];
        if (alpha !== expected[pixel + 3]) mismatches++;
        for (let channel = 0; channel < 3; channel++) {
          const normalized = Math.round(actual[pixel + channel] * alpha / 255);
          if (Math.abs(normalized - expected[pixel + channel]) > (alpha > 0 && alpha < 255 ? 1 : 0)) mismatches++;
        }
      }
      assert.equal(mismatches, 0, 'Native window icon pixels match after alpha normalization');
      matched = true;
    }
    offset += width * height;
  }
  assert.ok(matched, 'Native window contains the full selected icon');
  return { windowId: id, size: source.size, pixelSha256: createHash('sha256').update(expected).digest('hex') };
}
