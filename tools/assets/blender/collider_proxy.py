"""
Headless Blender: build a low-poly collider proxy from a high-res mesh (goal.md AF-3, PHY-1, PHY-5).
Usage: blender -b --python tools/assets/blender/collider_proxy.py -- --in hq.glb --out collider.glb --target 60000
Works with Marble HQ mesh exports, Tripo meshes, or any GLB. Cycles/EEVEE not needed (no rendering).
"""
import argparse
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", dest="out", required=True)
    p.add_argument("--target", type=int, default=60000, help="target triangle count")
    p.add_argument("--voxel", type=float, default=0.0, help="optional voxel remesh size (m) before decimation")
    return p.parse_args(argv)


def main():
    a = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=a.inp)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no meshes in input")
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    # strip materials — colliders are invisible
    obj.data.materials.clear()

    if a.voxel > 0:
        m = obj.modifiers.new("Remesh", "REMESH")
        m.mode = "VOXEL"
        m.voxel_size = a.voxel
        bpy.ops.object.modifier_apply(modifier=m.name)

    tri_count = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tri_count > a.target:
        d = obj.modifiers.new("Decimate", "DECIMATE")
        d.ratio = max(0.01, a.target / tri_count)
        bpy.ops.object.modifier_apply(modifier=d.name)

    bpy.ops.export_scene.gltf(
        filepath=a.out,
        export_format="GLB",
        export_apply=True,
        export_materials="NONE",
        export_normals=False,
        export_texcoords=False,
        export_draco_mesh_compression_enable=False,  # colliders are read by Rapier, not rendered: keep them Draco-free
    )
    # Post-step (AF-4): `gltf-transform meshopt collider.glb collider.glb` for size; loaders decode meshopt without a Draco path.
    final = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"collider written: {a.out} tris={final} (from {tri_count})")


if __name__ == "__main__":
    main()
