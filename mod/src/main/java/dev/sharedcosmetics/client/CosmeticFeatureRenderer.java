package dev.sharedcosmetics.client;

import java.util.Map;
import net.minecraft.client.model.ModelPart;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.feature.FeatureRenderer;
import net.minecraft.client.render.entity.feature.FeatureRendererContext;
import net.minecraft.client.render.entity.model.PlayerEntityModel;
import net.minecraft.client.render.entity.state.PlayerEntityRenderState;
import net.minecraft.client.util.math.MatrixStack;
import org.joml.Matrix4f;

/**
 * Draws each equipped cosmetic's model on its bone, so it follows every pose. Until a bundle has
 * downloaded, a small colored box stands in for it.
 */
final class CosmeticFeatureRenderer extends FeatureRenderer<PlayerEntityRenderState, PlayerEntityModel> {

    private final EquippedCache cache;
    private final BundleStore bundles;

    CosmeticFeatureRenderer(FeatureRendererContext<PlayerEntityRenderState, PlayerEntityModel> context, EquippedCache cache,
            BundleStore bundles) {
        super(context);
        this.cache = cache;
        this.bundles = bundles;
    }

    @Override
    public void render(MatrixStack matrices, VertexConsumerProvider vertices, int light, PlayerEntityRenderState state,
            float limbAngle, float limbDistance) {
        if (state.invisible) return;
        Map<String, CosmeticsApi.ModelSpec> models = cache.modelsFor(state.name);
        if (models.isEmpty()) return;
        PlayerEntityModel model = getContextModel();
        for (Map.Entry<String, CosmeticsApi.ModelSpec> e : models.entrySet()) {
            ModelPart bone = switch (e.getValue().bone()) {
                case "head" -> model.head;
                case "left_arm" -> model.leftArm;
                case "right_arm" -> model.rightArm;
                case "left_leg" -> model.leftLeg;
                case "right_leg" -> model.rightLeg;
                default -> model.body;
            };
            matrices.push();
            bone.rotate(matrices);
            BundleModel bundle = bundles.get(e.getValue().bundle());
            if (bundle != null) {
                VertexConsumer out = vertices.getBuffer(RenderLayer.getEntityCutoutNoCull(bundle.texture));
                bundle.render(matrices, out, light, e.getValue().animations(), state.age / 20f);
            } else {
                // One color per bundle, so different cosmetics are tellable apart while they load.
                int color = 0xFF000000 | (e.getValue().bundle().hashCode() & 0xFFFFFF);
                placeholder(matrices, vertices.getBuffer(RenderLayer.getDebugQuads()), e.getKey(), color);
            }
            matrices.pop();
        }
    }

    /** A box where the slot's cosmetic sits, in model pixels relative to the bone. */
    private static void placeholder(MatrixStack matrices, VertexConsumer out, String slot, int color) {
        switch (slot) {
            case "head" -> box(matrices, out, color, -3, -11, -3, 3, -8, 3);
            case "back" -> box(matrices, out, color, -7, 0, 2.5f, 7, 9, 3.5f);
            case "pet" -> box(matrices, out, color, 5, -2, -1.5f, 8, 1, 1.5f);
            case "aura" -> box(matrices, out, color, -5, 12.5f, -5, 5, 13, 5);
            default -> box(matrices, out, color, -1, -1, -1, 1, 1, 1);
        }
    }

    private static void box(MatrixStack matrices, VertexConsumer out, int color,
            float x1, float y1, float z1, float x2, float y2, float z2) {
        Matrix4f m = matrices.peek().getPositionMatrix();
        float s = 1 / 16f;
        x1 *= s; y1 *= s; z1 *= s; x2 *= s; y2 *= s; z2 *= s;
        quad(m, out, color, x1, y1, z1, x2, y1, z1, x2, y2, z1, x1, y2, z1);
        quad(m, out, color, x1, y1, z2, x1, y2, z2, x2, y2, z2, x2, y1, z2);
        quad(m, out, color, x1, y1, z1, x1, y2, z1, x1, y2, z2, x1, y1, z2);
        quad(m, out, color, x2, y1, z1, x2, y1, z2, x2, y2, z2, x2, y2, z1);
        quad(m, out, color, x1, y1, z1, x1, y1, z2, x2, y1, z2, x2, y1, z1);
        quad(m, out, color, x1, y2, z1, x2, y2, z1, x2, y2, z2, x1, y2, z2);
    }

    private static void quad(Matrix4f m, VertexConsumer out, int color, float... xyz) {
        for (int i = 0; i < 12; i += 3) out.vertex(m, xyz[i], xyz[i + 1], xyz[i + 2]).color(color);
    }
}
