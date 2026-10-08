package dev.sharedcosmetics;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.entity.Player;
import org.bukkit.entity.Pose;
import org.bukkit.util.Transformation;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/**
 * Works out where a hat sits on a player's head for each pose. The hat display rides the player, so
 * its origin is the top of the player's hitbox, which moves (and shrinks) with the pose. From there
 * we find the neck, tilt around it the way the head is tilted, and put the hat {@code height} above it.
 * Coordinates are in the display's frame: it is turned to the player's yaw, +Y is up, +Z is forward.
 */
public final class HatPlacement {

    /** Neck position relative to the top of the hitbox. "along" runs with the body: forward when upright, along the look direction when lying flat. */
    public record Neck(float up, float along) {
        static Neck from(ConfigurationSection section, Neck fallback) {
            if (section == null) return fallback;
            return new Neck((float) section.getDouble("up", fallback.up), (float) section.getDouble("along", fallback.along));
        }
    }

    // Defaults come from the vanilla player model; tune them in config.yml if hats look off in game.
    static final Neck STANDING = new Neck(-0.39f, 0f);
    static final Neck SNEAKING = new Neck(-0.46f, 0f);
    static final Neck SWIMMING = new Neck(-0.3f, 0.4f);
    static final Neck GLIDING = new Neck(-0.6f, 1.4f);

    private final float height;
    private final Neck standing;
    private final Neck sneaking;
    private final Neck swimming;
    private final Neck gliding;

    public HatPlacement(float height, Neck standing, Neck sneaking, Neck swimming, Neck gliding) {
        this.height = height;
        this.standing = standing;
        this.sneaking = sneaking;
        this.swimming = swimming;
        this.gliding = gliding;
    }

    public static HatPlacement fromConfig(ConfigurationSection hat) {
        if (hat == null) return new HatPlacement(0.14f, STANDING, SNEAKING, SWIMMING, GLIDING);
        ConfigurationSection poses = hat.getConfigurationSection("poses");
        return new HatPlacement(
                (float) hat.getDouble("height", 0.14),
                Neck.from(poses == null ? null : poses.getConfigurationSection("standing"), STANDING),
                Neck.from(poses == null ? null : poses.getConfigurationSection("sneaking"), SNEAKING),
                Neck.from(poses == null ? null : poses.getConfigurationSection("swimming"), SWIMMING),
                Neck.from(poses == null ? null : poses.getConfigurationSection("gliding"), GLIDING));
    }

    /** Returns the hat's transformation for the player's current pose, or null when no hat should show. */
    public Transformation forPose(Player player) {
        Pose pose = player.getPose();
        // Rounded to 2 degrees so tiny head movements don't send an update every tick.
        float pitch = (float) Math.toRadians(Math.round(player.getLocation().getPitch() / 2f) * 2f);
        return switch (pose) {
            case STANDING -> place(standing, pitch, false);
            case SNEAKING -> place(sneaking, pitch, false);
            // Crawling uses the swimming pose too, but the body stays flat instead of following the view.
            case SWIMMING -> place(swimming, player.isInWater() ? pitch : 0f, true);
            case FALL_FLYING -> place(gliding, pitch, true);
            // Sleeping, riptide spins and the rest move the head in ways a single display can't follow.
            default -> null;
        };
    }

    /**
     * @param angle head pitch when upright, body pitch when lying flat (radians, positive is down)
     * @param lying whether the body lies along the look direction (swimming, gliding)
     */
    Transformation place(Neck neck, float angle, boolean lying) {
        // Direction the body extends from the neck pivot's base, and how far the head is tilted forward.
        Vector3f bodyDir = lying ? new Vector3f(0, (float) -Math.sin(angle), (float) Math.cos(angle)) : new Vector3f(0, 0, 1);
        float tilt = lying ? angle + (float) (Math.PI / 2) : Math.clamp(angle, (float) -Math.PI / 2, (float) Math.PI / 2);
        Quaternionf rotation = new Quaternionf().rotateX(tilt);
        Vector3f translation = new Vector3f(0, neck.up(), 0)
                .add(bodyDir.mul(neck.along()))
                .add(rotation.transform(new Vector3f(0, height, 0)));
        return new Transformation(translation, rotation, new Vector3f(1, 1, 1), new Quaternionf());
    }
}
