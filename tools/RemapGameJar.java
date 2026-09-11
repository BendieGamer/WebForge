import net.fabricmc.loader.impl.lib.mappingio.MappingReader;
import net.fabricmc.loader.impl.lib.mappingio.tree.MemoryMappingTree;
import net.fabricmc.loader.impl.lib.tinyremapper.InputTag;
import net.fabricmc.loader.impl.lib.tinyremapper.NonClassCopyMode;
import net.fabricmc.loader.impl.lib.tinyremapper.OutputConsumerPath;
import net.fabricmc.loader.impl.lib.tinyremapper.TinyRemapper;
import net.fabricmc.loader.impl.lib.tinyremapper.TinyUtils;
import net.fabricmc.loader.impl.lib.tinyremapper.api.TrLogger;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.zip.ZipFile;

/** Remaps the vanilla client jar from the official namespace to intermediary, ahead of time. */
public class RemapGameJar {
    public static void main(String[] args) throws Exception {
        Path input = Paths.get(args[0]);
        Path output = Paths.get(args[1]);
        Path mappingsJar = Paths.get(args[2]);

        Path[] classpath = new Path[args.length - 3];
        for (int i = 3; i < args.length; i++) classpath[i - 3] = Paths.get(args[i]);

        MemoryMappingTree tree = new MemoryMappingTree();
        try (ZipFile zf = new ZipFile(mappingsJar.toFile())) {
            InputStream in = zf.getInputStream(zf.getEntry("mappings/mappings.tiny"));
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            MappingReader.read(reader, tree);
        }
        System.out.println("[remap] mapped classes: " + tree.getClasses().size());

        TrLogger logger = (level, message) -> {
            if (level == TrLogger.Level.ERROR || level == TrLogger.Level.WARN) {
                System.out.println("[remap/" + level + "] " + message);
            }
        };

        TinyRemapper remapper = TinyRemapper.newRemapper(logger)
                .withMappings(TinyUtils.createMappingProvider(tree, "official", "intermediary"))
                .renameInvalidLocals(false)
                .rebuildSourceFilenames(false)
                .build();

        Files.deleteIfExists(output);

        try (OutputConsumerPath consumer = new OutputConsumerPath.Builder(output).assumeArchive(true).build()) {
            consumer.addNonClassFiles(input, NonClassCopyMode.FIX_META_INF, remapper);
            remapper.readClassPathAsync(classpath).join();
            InputTag tag = remapper.createInputTag();
            remapper.readInputsAsync(tag, input).join();
            remapper.apply(consumer, tag);
        } finally {
            remapper.finish();
        }

        System.out.println("[remap] wrote " + output + " (" + Files.size(output) + " bytes)");
    }
}
