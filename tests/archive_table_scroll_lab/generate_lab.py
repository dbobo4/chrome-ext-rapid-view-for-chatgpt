from __future__ import annotations

import json
import webbrowser
from pathlib import Path


# CONFIG: Set to False if you only want to regenerate files without opening the browser.
OPEN_BROWSER_AFTER_GENERATE = True
# CONFIG: Generated outputs stay here so you can inspect them directly after each run.
GENERATED_FOLDER_NAME = "generated"
# CONFIG: Change if you want a different local winner storage template name.
WINNER_TEMPLATE_FILENAME = "winner.template.json"


ROOT_DIR = Path(__file__).resolve().parent
GENERATED_DIR = ROOT_DIR / GENERATED_FOLDER_NAME
SCENARIOS_PATH = ROOT_DIR / "scenarios.json"
VARIANTS_PATH = ROOT_DIR / "variants.json"
HTML_TEMPLATE_PATH = ROOT_DIR / "lab_template.html"
CSS_TEMPLATE_PATH = ROOT_DIR / "lab_template.css"
JS_TEMPLATE_PATH = ROOT_DIR / "lab_template.js"


def read_json(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_generated_dir() -> None:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)


def build_lab_js(scenarios: list[dict], variants: list[dict]) -> str:
    payload = {
        "scenarios": scenarios,
        "variants": variants,
    }
    template = JS_TEMPLATE_PATH.read_text(encoding="utf-8")
    return template.replace("__LAB_DATA__", json.dumps(payload, ensure_ascii=False))


def open_generated_lab(index_path: Path) -> None:
    if not OPEN_BROWSER_AFTER_GENERATE:
        return

    try:
        webbrowser.open(index_path.resolve().as_uri())
        print(f"[5/5] Opened browser: {index_path}")
    except Exception as error:  # pragma: no cover
        print(f"[5/5] Browser open skipped: {error}")


def main() -> None:
    print("[1/5] Loading scenarios and variants...")
    scenarios = read_json(SCENARIOS_PATH)
    variants = read_json(VARIANTS_PATH)

    print("[2/5] Creating generated output folder...")
    ensure_generated_dir()

    print("[3/5] Writing generated HTML, CSS, and JS...")
    write_text(GENERATED_DIR / "index.html", HTML_TEMPLATE_PATH.read_text(encoding="utf-8"))
    write_text(GENERATED_DIR / "lab.css", CSS_TEMPLATE_PATH.read_text(encoding="utf-8"))
    write_text(GENERATED_DIR / "lab.js", build_lab_js(scenarios, variants))

    print("[4/5] Writing generated data snapshots...")
    write_json(GENERATED_DIR / "scenarios.generated.json", scenarios)
    write_json(GENERATED_DIR / "variants.generated.json", variants)
    write_json(
        GENERATED_DIR / WINNER_TEMPLATE_FILENAME,
        {
            "variantId": "",
            "variantLabel": "",
            "scenarioId": "",
            "scenarioLabel": "",
            "mode": "manual",
            "viewportWidth": 760,
            "settings": {}
        }
    )

    index_path = GENERATED_DIR / "index.html"
    print(f"Generated lab: {index_path}")
    open_generated_lab(index_path)


if __name__ == "__main__":
    main()
