"""최소 예제: python parse_document.py 문서.hwpx [--gfm]

KORDOC_CLI(엔진 dist/cli.js 또는 npm 의 kordoc)와 KORDOC_NODE 를 지정하거나 PATH 에 node·kordoc 이 있어야 한다.
"""

import sys

from kordoc import KordocClient


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: parse_document.py <문서> [--gfm]", file=sys.stderr)
        return 2
    options = {"table_format": "gfm"} if "--gfm" in sys.argv[2:] else {}
    with KordocClient() as client:
        result = client.parse(sys.argv[1], **options)
        if not result.success:
            print(f"파싱 실패 ({result.code}): {result.error}", file=sys.stderr)
            return 1
        print(result.markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
