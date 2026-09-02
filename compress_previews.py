"""One-off: lighten EXISTING preview GLBs in place (no reconversion).
Textured meshes keep their faces and UVs but the embedded texture is
downscaled to 512px (full-res textures were the load-time culprit);
untextured meshes are decimated to ~2000 faces.

    pip install trimesh pillow fast-simplification
    python shrink_previews.py /media/data_siyeon/ycb/preview
"""
import os
import sys
import glob

import trimesh

TEX_SIZE = 512
MAX_FACES = 2000

preview_dir = sys.argv[1]
for path in sorted(glob.glob(os.path.join(preview_dir, "*.glb"))):
    m = trimesh.load(path, force="mesh")
    before = os.path.getsize(path)
    mat = getattr(getattr(m, "visual", None), "material", None)
    img_attr = next((a for a in ("baseColorTexture", "image")
                     if getattr(mat, a, None) is not None), None)
    if img_attr is not None:
        img = getattr(mat, img_attr)
        if max(img.size) > TEX_SIZE:
            scale = TEX_SIZE / max(img.size)
            setattr(mat, img_attr, img.resize((max(1, int(img.size[0] * scale)),
                                               max(1, int(img.size[1] * scale)))))
        note = f"tex {img.size[0]}px -> {TEX_SIZE}px"
    else:
        lite = trimesh.Trimesh(vertices=m.vertices, faces=m.faces, process=False)
        if len(lite.faces) > MAX_FACES:
            lite = lite.simplify_quadric_decimation(face_count=MAX_FACES)
        m = lite
        note = f"{len(m.faces)} faces (untextured)"
    m.export(path)
    print(f"{os.path.basename(path):32s} {before/1e6:5.2f} MB -> "
          f"{os.path.getsize(path)/1e6:5.2f} MB   {note}")