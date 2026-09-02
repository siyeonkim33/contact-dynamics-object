"""Standalone: lighten preview GLBs in place. No other file needed.
UV-preserving decimation to ~4000 faces + 512px JPEG texture re-encode.
UVs at texture seams can smear slightly after decimation (invisible at
grid scale; raise MAX_FACES for a specific object if its label looks off).

    pip install trimesh pillow fast-simplification
    python shrink_previews.py /media/data_siyeon/ycb/preview
"""
import io
import os
import sys
import glob

import numpy as np
import trimesh
import PIL.Image

TEX_SIZE = 512
MAX_FACES = 4000
JPEG_QUALITY = 80


def lighten(tm):
    mat = getattr(getattr(tm, "visual", None), "material", None)
    img_attr = next((a for a in ("baseColorTexture", "image")
                     if getattr(mat, a, None) is not None), None)
    uv = getattr(tm.visual, "uv", None) if img_attr else None

    verts, faces = tm.vertices, tm.faces
    if len(faces) > MAX_FACES:
        try:
            # collapse replay maps surviving vertices back to originals,
            # so each survivor keeps its original UV
            import fast_simplification as fs
            _, _, collapses = fs.simplify(verts.astype(np.float32), faces.astype(np.int32),
                                          target_count=MAX_FACES, return_collapses=True)
            verts, faces, imap = fs.replay_simplification(
                tm.vertices.astype(np.float32), tm.faces.astype(np.int32), collapses)
            if uv is not None:
                new_uv = np.zeros((len(verts), 2))
                new_uv[imap] = uv
                uv = new_uv
        except BaseException as e:
            print(f"[WARN] decimation unavailable ({e}); keeping faces")
            verts, faces = tm.vertices, tm.faces

    if img_attr is None:
        return trimesh.Trimesh(vertices=verts, faces=faces, process=False)

    # embedded full-res PNGs are the load-time culprit: shrink + JPEG-encode
    img = getattr(mat, img_attr)
    if max(img.size) > TEX_SIZE:
        scale = TEX_SIZE / max(img.size)
        img = img.resize((max(1, int(img.size[0] * scale)), max(1, int(img.size[1] * scale))))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    jpeg = PIL.Image.open(io.BytesIO(buf.getvalue()))  # format=JPEG -> glb embeds image/jpeg
    return trimesh.Trimesh(vertices=verts, faces=faces, process=False,
                           visual=trimesh.visual.TextureVisuals(uv=uv, image=jpeg))


if __name__ == "__main__":
    for path in sorted(glob.glob(os.path.join(sys.argv[1], "*.glb"))):
        m = trimesh.load(path, force="mesh")
        before = os.path.getsize(path)
        lighten(m).export(path)
        print(f"{os.path.basename(path):32s} {before/1e6:5.2f} MB -> {os.path.getsize(path)/1e3:5.0f} KB")