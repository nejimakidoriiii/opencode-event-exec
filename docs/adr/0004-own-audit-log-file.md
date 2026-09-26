# 実行ログは OpenCode 本体ログに混ぜずプラグイン独自ファイルに書く

コマンド実行の監査記録(実行ログ)は、OpenCode 本体のログ(`opencode.log`)ではなく本プラグイン専用のファイルに追記する。promise 型プラグインの Context には logger API がなく(opencode 側 `packages/plugin/src/promise/plugin.ts`)、effect 型プラグインにすれば `Effect.log` で本体ログに書けるが、監査要件は「本プラグインの実行履歴の一覧性」にあり、本体ログへの混入は他ログとの分離も容量管理も本体に委ねることになる。またプラグイン storage API はキーバリュー型(get / set / remove / scan)でテール可能なファイルを提供しないため不採用とした。実装は promise 型プラグイン + 自前のファイル追記とする。

## Consequences

- OpenCode v2 のデータディレクトリは全プラットフォームで XDG のみで解決される(`$XDG_DATA_HOME`、既定 `~/.local/share`。macOS / Windows でもプラットフォーム標準ディレクトリへの特殊処理なし)。本プラグインはこの解決規則を複製し、`<データディレクトリ>/opencode/log/event-exec.log` に置く。本体内部 API(`Global.Path`)には依存しないため、規則の複製が本体側で変わった場合に追従が必要になる。
