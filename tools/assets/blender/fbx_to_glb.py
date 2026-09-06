"""
Headless Blender: convert Mixamo (or any) FBX animation clips onto a rigged GLB with Mixamo bone names,
emitting one GLB with named clips (goal.md CHR-2, AF-3). Skinned meshes are exported WITHOUT Draco (AF-4).
Usage: blender -b --python tools/assets/blender/fbx_to_glb.py -- --rig character.glb --clips walk.fbx run.fbx --out character.anim.glb
"""
import argparse
import os
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--rig", required=True, help="rigged GLB (Tripo spec=mixamo)")
    p.add_argument("--clips", nargs="+", required=True, help="FBX files; clip name = file stem")
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


MIXAMO_CORE = {"Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"}


def bone_names(arm):
    return {b.name for b in arm.data.bones}


def normalize_prefix(arm):
    """Mixamo FBX bones are `mixamorig:Hips`; Tripo `spec:mixamo` rigs may omit the prefix. Normalize to the rig's convention."""
    return {n.split(":")[-1] for n in bone_names(arm)}


def validate_rig(arm):
    names = normalize_prefix(arm)
    missing = MIXAMO_CORE - names
    if missing:
        raise SystemExit(f"rig is missing Mixamo core bones: {sorted(missing)} (goal.md CHR-1)")
    if len(arm.data.bones) > 80:
        raise SystemExit(f"rig has {len(arm.data.bones)} bones (> 80, CHR-1)")
    dims = arm.dimensions
    if not (1.2 < max(dims) < 2.4):
        raise SystemExit(f"rig height {max(dims):.2f} m is not a human scale — 1 unit must be 1 m (CHR-1); Mixamo FBX is in cm (scale 0.01)")


def main():
    a = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=a.rig)
    arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if arm is None:
        raise SystemExit("rig has no armature")
    validate_rig(arm)
    rig_has_prefix = any(n.startswith("mixamorig:") for n in bone_names(arm))
    arm.animation_data_create()
    for clip in a.clips:
        name = os.path.splitext(os.path.basename(clip))[0]
        before = set(bpy.data.actions.keys())
        # Mixamo FBX is authored in centimetres: global_scale=0.01 brings it to metres so the action's root motion matches.
        bpy.ops.import_scene.fbx(filepath=clip, use_anim=True, ignore_leaf_bones=True, automatic_bone_orientation=False, global_scale=0.01)
        new_actions = [bpy.data.actions[k] for k in set(bpy.data.actions.keys()) - before]
        # Rename F-curve data paths so `mixamorig:` prefixes match the rig's convention.
        for act in new_actions:
            for fc in act.fcurves:
                if rig_has_prefix and 'pose.bones["' in fc.data_path and 'pose.bones["mixamorig:' not in fc.data_path:
                    fc.data_path = fc.data_path.replace('pose.bones["', 'pose.bones["mixamorig:', 1)
                elif not rig_has_prefix:
                    fc.data_path = fc.data_path.replace('pose.bones["mixamorig:', 'pose.bones["')
        # remove the imported FBX armature/mesh; keep only its action, renamed and pushed as an NLA track
        for o in [o for o in bpy.context.scene.objects if o.type in {"ARMATURE", "MESH"} and o is not arm and o.parent is not arm]:
            bpy.data.objects.remove(o, do_unlink=True)
        for act in new_actions:
            act.name = name
            # NOTE: this assumes matching bone names + rest pose (mixamo spec). Retarget/validation step (CHR-1) happens in CI.
            track = arm.animation_data.nla_tracks.new()
            track.name = name
            track.strips.new(name, 1, act)
    bpy.ops.export_scene.gltf(
        filepath=a.out,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_skins=True,
        export_apply=False,
        export_draco_mesh_compression_enable=False,
        export_image_format="AUTO",
    )
    print(f"written {a.out} with clips: {[t.name for t in arm.animation_data.nla_tracks]}")


if __name__ == "__main__":
    main()
