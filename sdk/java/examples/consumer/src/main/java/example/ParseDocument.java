package example;

import app.gomdori.kordoc.KordocClient;
import app.gomdori.kordoc.KordocConfig;
import app.gomdori.kordoc.ParseOptions;
import app.gomdori.kordoc.ParseResult;
import java.nio.file.Path;
import java.util.Arrays;

/** 최소 예제: KORDOC_CLI(엔진 dist/cli.js)·KORDOC_NODE 를 지정하거나 PATH 에 node·kordoc 이 있어야 한다 */
public final class ParseDocument {
    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("usage: ParseDocument <문서> [--gfm]");
            System.exit(2);
        }
        ParseOptions.Builder options = ParseOptions.builder();
        if (Arrays.asList(args).contains("--gfm")) options.tableFormat("gfm");
        ParseResult result;
        try (KordocClient client = KordocClient.start(KordocConfig.defaults())) {
            result = client.parse(Path.of(args[0]), options.build());
        }
        if (!result.success()) {
            System.err.println("파싱 실패 (" + result.code().orElse("") + "): " + result.error().orElse(""));
            System.exit(1);
        }
        System.out.println(result.markdown());
    }
}
