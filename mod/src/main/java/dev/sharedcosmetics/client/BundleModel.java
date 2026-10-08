package dev.sharedcosmetics.client;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.model.ModelPart;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.OverlayTexture;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Direction;

/**
 * A bundle's geometry built into vanilla model parts, so it draws with the game's own cuboid
 * renderer, plus its animations. Bedrock is y-up with x mirrored relative to Java model space, so
 * points map as (x, y, z) to (-x, -y, z) and rotations as (rx, ry, rz) to (-rx, -ry, rz).
 */
final class BundleModel {

    private record Bone(ModelPart part, float pivotX, float pivotY, float pivotZ, float pitch, float yaw, float roll) {}

    final Identifier texture;
    private final ModelPart root;
    private final Map<String, Bone> bones;
    private final BedrockAnimation animations;

    private BundleModel(Identifier texture, ModelPart root, Map<String, Bone> bones, BedrockAnimation animations) {
        this.texture = texture;
        this.root = root;
        this.bones = bones;
        this.animations = animations;
    }

    static BundleModel build(BedrockGeometry geo, BedrockAnimation animations, Identifier texture) {
        Map<String, List<BedrockGeometry.Bone>> childrenOf = new HashMap<>();
        Map<String, BedrockGeometry.Bone> byName = new HashMap<>();
        for (BedrockGeometry.Bone b : geo.bones()) byName.put(b.name(), b);
        List<BedrockGeometry.Bone> tops = new ArrayList<>();
        for (BedrockGeometry.Bone b : geo.bones()) {
            if (b.parent() != null && byName.containsKey(b.parent())) childrenOf.computeIfAbsent(b.parent(), k -> new ArrayList<>()).add(b);
            else tops.add(b);
        }
        Map<String, Bone> built = new HashMap<>();
        Map<String, ModelPart> roots = new LinkedHashMap<>();
        // Bones whose parents form a loop are never reached from a top-level bone, so they're dropped.
        for (BedrockGeometry.Bone b : tops) roots.put(b.name(), buildBone(b, new float[3], childrenOf, built, geo));
        return new BundleModel(texture, new ModelPart(List.of(), roots), built, animations);
    }

    private static ModelPart buildBone(BedrockGeometry.Bone b, float[] parentPivot, Map<String, List<BedrockGeometry.Bone>> childrenOf,
            Map<String, Bone> built, BedrockGeometry geo) {
        Map<String, ModelPart> children = new LinkedHashMap<>();
        List<ModelPart.Cuboid> cuboids = new ArrayList<>();
        int i = 0;
        for (BedrockGeometry.Cube c : b.cubes()) {
            if (c.rotation() == null) {
                cuboids.add(cuboid(c, b.pivot(), geo));
            } else {
                // A rotated cube becomes its own child part pivoting where the cube says.
                float[] pivot = c.pivot() != null ? c.pivot() : b.pivot();
                ModelPart part = new ModelPart(List.of(cuboid(c, pivot, geo)), Map.of());
                part.pivotX = b.pivot()[0] - pivot[0];
                part.pivotY = b.pivot()[1] - pivot[1];
                part.pivotZ = pivot[2] - b.pivot()[2];
                part.pitch = rad(-c.rotation()[0]);
                part.yaw = rad(-c.rotation()[1]);
                part.roll = rad(c.rotation()[2]);
                children.put("cube_" + i, part);
            }
            i++;
        }
        for (BedrockGeometry.Bone child : childrenOf.getOrDefault(b.name(), List.of())) {
            if (!built.containsKey(child.name())) children.put(child.name(), buildBone(child, b.pivot(), childrenOf, built, geo));
        }
        ModelPart part = new ModelPart(cuboids, children);
        part.pivotX = parentPivot[0] - b.pivot()[0];
        part.pivotY = parentPivot[1] - b.pivot()[1];
        part.pivotZ = b.pivot()[2] - parentPivot[2];
        part.pitch = rad(-b.rotation()[0]);
        part.yaw = rad(-b.rotation()[1]);
        part.roll = rad(b.rotation()[2]);
        built.put(b.name(), new Bone(part, part.pivotX, part.pivotY, part.pivotZ, part.pitch, part.yaw, part.roll));
        return part;
    }

    /** A Bedrock cube as a vanilla cuboid, positioned relative to the pivot of the part holding it. */
    private static ModelPart.Cuboid cuboid(BedrockGeometry.Cube c, float[] pivot, BedrockGeometry geo) {
        float x = pivot[0] - c.origin()[0] - c.size()[0];
        float y = pivot[1] - c.origin()[1] - c.size()[1];
        float z = c.origin()[2] - pivot[2];
        float g = c.inflate();
        return new ModelPart.Cuboid(c.u(), c.v(), x, y, z, c.size()[0], c.size()[1], c.size()[2], g, g, g,
                !c.mirror(), geo.textureWidth(), geo.textureHeight(), EnumSet.allOf(Direction.class));
    }

    private static float rad(float degrees) {
        return degrees * (float) (Math.PI / 180);
    }

    /** Poses the bones for this moment, then draws the model at the current matrix. */
    void render(MatrixStack matrices, VertexConsumer out, int light, List<String> clips, float seconds) {
        Map<String, BedrockAnimation.Pose> poses = new HashMap<>();
        animations.sample(clips, seconds, poses);
        for (Map.Entry<String, Bone> e : bones.entrySet()) {
            Bone b = e.getValue();
            BedrockAnimation.Pose pose = poses.get(e.getKey());
            ModelPart p = b.part;
            p.pivotX = b.pivotX;
            p.pivotY = b.pivotY;
            p.pivotZ = b.pivotZ;
            p.pitch = b.pitch;
            p.yaw = b.yaw;
            p.roll = b.roll;
            p.xScale = p.yScale = p.zScale = 1;
            if (pose == null) continue;
            p.pivotX -= pose.position()[0];
            p.pivotY -= pose.position()[1];
            p.pivotZ += pose.position()[2];
            p.pitch += rad(-pose.rotation()[0]);
            p.yaw += rad(-pose.rotation()[1]);
            p.roll += rad(pose.rotation()[2]);
            p.xScale = pose.scale()[0];
            p.yScale = pose.scale()[1];
            p.zScale = pose.scale()[2];
        }
        root.render(matrices, out, light, OverlayTexture.DEFAULT_UV);
    }
}
