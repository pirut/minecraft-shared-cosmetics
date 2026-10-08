package dev.sharedcosmetics.client;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BedrockTest {

    private static final Path WINGS = Path.of("..", "examples", "phoenix_wings");

    private static String read(String file) throws IOException {
        return Files.readString(WINGS.resolve(file));
    }

    @Test
    void parsesTheExampleWings() throws IOException {
        BedrockGeometry geo = BedrockGeometry.parse(read("geometry.json"));
        assertEquals(32, geo.textureWidth());
        assertEquals(List.of("wings", "left_wing", "right_wing"), geo.bones().stream().map(BedrockGeometry.Bone::name).toList());
        BedrockGeometry.Bone left = geo.bones().get(1);
        assertEquals("wings", left.parent());
        assertArrayEquals(new float[] {0, -25, 0}, left.rotation());
        BedrockGeometry.Cube cube = left.cubes().get(0);
        assertArrayEquals(new float[] {12, 10, 1}, cube.size());
        assertNull(cube.rotation());
        assertEquals(true, geo.bones().get(2).cubes().get(0).mirror());
    }

    @Test
    void samplesAnimationsByShortNameAndLoops() throws IOException {
        BedrockAnimation anim = BedrockAnimation.parse(read("animations.json"));
        Map<String, BedrockAnimation.Pose> poses = new HashMap<>();
        anim.sample(List.of("flap"), 0.3f, poses);
        assertEquals(-17.5f, poses.get("left_wing").rotation()[1], 1e-4);
        assertEquals(17.5f, poses.get("right_wing").rotation()[1], 1e-4);

        poses.clear();
        anim.sample(List.of("animation.phoenix_wings.flap"), 1.2f + 0.6f, poses);
        assertEquals(-35f, poses.get("left_wing").rotation()[1], 1e-4);

        poses.clear();
        anim.sample(List.of("idle", "missing"), 1.5f, poses);
        assertEquals(0.5f, poses.get("wings").position()[1], 1e-4);
        assertArrayEquals(new float[] {1, 1, 1}, poses.get("wings").scale());
    }

    @Test
    void handlesConstantsPrePostAndMolang() {
        BedrockAnimation anim = BedrockAnimation.parse("""
                {"animations": {"spin": {"loop": true, "animation_length": 2, "bones": {"b": {
                  "rotation": {"0": {"post": [0, 0, 0]}, "2": {"pre": [0, 360, 0]}},
                  "position": [1, "math.sin(query.anim_time)", 3],
                  "scale": 2
                }}}}}
                """);
        Map<String, BedrockAnimation.Pose> poses = new HashMap<>();
        anim.sample(List.of("spin"), 0.5f, poses);
        BedrockAnimation.Pose b = poses.get("b");
        assertEquals(90f, b.rotation()[1], 1e-4);
        assertArrayEquals(new float[] {1, 0, 3}, b.position());
        assertArrayEquals(new float[] {2, 2, 2}, b.scale());
    }

    @Test
    void rejectsGeometryOverTheLimits() {
        StringBuilder bones = new StringBuilder();
        for (int i = 0; i <= BedrockGeometry.MAX_BONES; i++) bones.append(i == 0 ? "" : ",").append("{\"name\":\"b").append(i).append("\"}");
        String json = "{\"minecraft:geometry\":[{\"bones\":[" + bones + "]}]}";
        assertThrows(IllegalArgumentException.class, () -> BedrockGeometry.parse(json));
        assertThrows(IllegalArgumentException.class, () -> BedrockGeometry.parse("{}"));
    }
}
