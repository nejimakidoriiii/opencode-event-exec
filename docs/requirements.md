# opencode-event-exec 要件定義書

- リポジトリ: `opencode-event-exec`
- GitHub Description(案): "Run custom commands and scripts in response to OpenCode v2 events."
- ステータス: v2(2026-09-26、grill-with-docs セッションで全決定事項を確定)
- 関連ドキュメント: 用語は `../CONTEXT.md`、経緯のある決定は `./adr/0001`〜`0004`

## Context / Goal

### Context

mohak34/opencode-notifier は OpenCode v1 向けの通知プラグインであり、その Custom commands 機能(イベント発生時に任意のコマンド・スクリプトを実行する)を OpenCode v2 向けとして独立させたプラグインを作る。

OpenCode v2 について以下をソースで確認済み(`/home/masano/.ghq/github.com/anomalyco/opencode`)。

- プラグインは `setup(context)` の `context.event.subscribe()` で公開イベントストリーム(約80種のイベントタイプ)を購読できる。購読 API にイベント種別のフィルタ指定はなく、プラグイン側で絞り込む。
- プラグイン設定は `opencode.json` の `plugins: [{ package, options }]` の `options` として渡され、`context.options` で読む。
- イベントオブジェクトは `{ id, type, created, data, location?, metadata? }` 形状。`timestamp` / `properties` フィールドは存在せず、時刻はトップレベルの `created`(エポックミリ秒)。
- `data.agent` / `data.model` を持つのは `session.created` や `session.step.started` など一部のイベントのみ。`session.idle`・`session.step.failed`・`permission.asked` の data には含まれない。
- `session.idle` は非推奨(deprecated)。後継は `session.status`(`data.status.type: "idle" / "busy" / "retry"`)。
- プラグイン Context に logger API はない。データディレクトリは全プラットフォームで XDG のみで解決される(`$XDG_DATA_HOME`、既定 `~/.local/share`)。

このため本プラグインは、mohak34 が独自に設けていた抽象イベント名(permission / complete / error など10種)を使わず、OpenCode v2 の公式イベントタイプ名をそのまま設定に書く方式を採る。

### Goal

OpenCode v2 のイベントタイプ名を指定してコマンドを登録すると、そのイベントが発生したときに指定したコマンド・スクリプトを実行するプラグインを提供する。プラグイン自身は「イベントの受け取りとコマンド実行の仲介」のみを行い、通知・音・メッセージ整形などの機能は持たない。

## In scope / Out of scope

### In scope

- OpenCode v2 の公開イベントストリームの購読。
- 設定におけるイベント指定: OpenCode v2 のイベントタイプ名(`session.idle`, `session.step.failed`, `permission.asked` など)による**完全一致**。
- コマンド登録: イベントごとに個別のコマンド(実行ファイルのパスと引数)を登録できる。1 イベントに複数コマンドの登録も可(並行実行、順序保証なし)。
- 引数のプレースホルダー置換。プレースホルダーは 6 種(ADR-0002):
  - `{event}`: イベントタイプ名(例: `session.idle`)
  - `{sessionID}`: ペイロードの `data.sessionID`(当該イベントが持つ場合)
  - `{agent}`: ペイロードの `data.agent`(同上)
  - `{model}`: ペイロードの `data.model`(同上)
  - `{created}`: トップレベルの `created`(エポックミリ秒の数値文字列)
  - `{data}`: `data` 全体の compact JSON 文字列(1 引数)
  - 参照先がイベントに存在しない場合、空文字列への置換も実行スキップもせず、`{agent}` 等のリテラル文字列のまま引数に渡る
- プレースホルダーを置換した値を**コマンドの引数(argv)として**渡す実行方式(シェルを介さない)。
- コマンド実行のタイムアウト: グローバル既定 10,000ms(`options.timeoutMs`)、ルールごとの上書き可。超過時は強制終了し実行ログに記録。
- コマンド出力の扱い: 成功時は破棄。失敗時(終了コード非ゼロ・タイムアウト・起動失敗)のみ先頭 4 KiB を実行ログに記録。
- 実行ログ(ADR-0004): プラグイン専用ファイルにコマンド実行の記録(実行時刻・イベント・コマンド・引数・終了コード・所要時間・タイムアウト判定・エラー抜粋)を JSONL で追記。
- 設定検証: 構造不正(必須フィールド欠落・型不一致・`timeoutMs` 非正数)は該当ルールを無効化し、実行ログに警告 + stderr に 1 行。OpenCode 本体は起動継続。未知のイベントタイプ名・未知のプレースホルダー名は検証しない。
- 起動時に有効なルール全件を実行ログに列挙(監査 NFR の「設定内容を確認する手段」)。
- クロスプラットフォーム対応(macOS / Linux / Windows 含む)。
- 利用者向けドキュメント(設定方法・プレースホルダー一覧・ephemeral・高頻度イベントへの注意・セキュリティ上の注意)。

### Out of scope

- 音の再生、OS 標準通知(デスクトップ通知)、ターミナルベルなどの通知機能全般。
- メッセージ本文の整形・テンプレート機能(mohak34 の `messages` 相当)。
- mohak34 互換の抽象イベント名(permission / complete / error 等)の提供。
- `sessionTitle` / `agentName` / `projectName` / `message` / `{turn}` のような、sessionID からの名前解決や永続カウンターを必要とするプレースホルダー。
- イベント名のワイルドカード・パターンマッチ(`session.*` 等)、ペイロード条件(`data.status.type == 'idle'` 等)。
- 同時実行数の上限・直列化・イベントごとのスキップといった実行制限(高頻度イベントの登録は可能、ドキュメントで警告のみ)。
- 同一イベント×同一コマンドの重複ルールの排除(書いた通りに重複実行する)。
- スパム抑制機能(`minDuration`、`suppressWhenFocused` 相当)。将来の後方互換追加は可能。
- コマンド実行の失敗をユーザーへ能動的に通知する仕組み。
- OpenCode 本体の操作(プロンプトやツール実行への介入)。
- ルールごとの `cwd` 指定(将来の後方互換追加は可能。現行はプロセスの cwd を継承)。

## 設定スキーマ(確定、ADR-0001)

```json
{
  "plugins": [
    {
      "package": "opencode-event-exec",
      "options": {
        "timeoutMs": 10000,
        "rules": [
          {
            "event": "session.idle",
            "command": "/usr/bin/notify-send",
            "args": ["{event}", "{sessionID}"],
            "timeoutMs": 5000
          }
        ]
      }
    }
  ]
}
```

- `rules`: ルールの配列。省略時はルールなし(何も実行しない)。
- ルールのフィールド: `event`(必須・文字列)、`command`(必須・文字列)、`args`(省略可・文字列配列)、`timeoutMs`(省略可・正整数。省略時は `options.timeoutMs`、その既定値 10000)。

## コマンド実行(確定)

- 実行方式: fire-and-forget で並行。順序保証なし。同時実行数の上限なし。
- 環境変数: OpenCode プロセスの環境を継承(追加の注入なし)。
- 標準入力: 接続しない(入力待ちでのハングを防止)。
- カレントディレクトリ: OpenCode プロセスの cwd を継承。
- タイムアウト超過時は強制終了(POSIX では SIGKILL 相当、Windows ではプロセス強制終了)し、実行ログにタイムアウトとして記録する。

## 実行ログ(確定、ADR-0004)

- パス: `$XDG_DATA_HOME`(既定 `~/.local/share`)配下の `opencode/log/event-exec.log`。パス解決規則は OpenCode 本体と同じ XDG のみ(macOS / Windows も含む)。本体内部 API には依存せず自前で解決する。
- 形式: JSONL。1 実行 = 1 行。フィールドは実行時刻・イベント・コマンド・引数・終了コード・所要時間・タイムアウト判定・エラー抜粋(失敗時、先頭 4 KiB)。
- 容量: インプレース切詰め。上限 10MB / 保持 5MB(OpenCode 本体と同じ方式)。
- 起動時: 有効なルール全件(イベント・コマンド・引数・タイムアウト値)を列挙するエントリを書く。構造不正ルールの警告もここに書く。

## User stories

1. **完了時に任意の処理を走らせたい**: 私はセッションがアイドルになったとき、自分が選んだ通知コマンド(notify-send、Slack 送信スクリプト等)を実行したい。それによってターミナルを見ていなくても完了を知れる。※ `session.idle` は v2 で非推奨だが公開ストリームには流れ続けるため登録可能。後継の `session.status` は busy / retry でも発火する点が異なる(ADR-0003)。
2. **エラーを記録したい**: 私は `session.step.failed` が発生したとき、エラー内容をファイルに追記するコマンドを実行し、後から障害を振り返えるようにしたい。※ このイベントの data に `agent` / `model` はない(`session.step.started` が持つ)。
3. **権限要求に反応したい**: 私は `permission.asked` が発生したとき任意のコマンドを実行したい。それによって承認待ちの見逃しを防げる。
4. **v1 から移植したい**: 私は mohak34/opencode-notifier の Custom commands を使って自作スクリプトを動かしていた。イベントタイプ名を v2 のものに書き換えて、同じスクリプトを v2 でも使いたい。
5. **イベントの学習・デバッグをしたい**: 私は関心のあるイベントタイプ名を登録して echo するコマンド(`{data}` 付き)を結びつけることで、OpenCode v2 でどんなイベントがいつ流れるのかを観察したい。
6. **イベントごとに別の処理を使い分けたい**: 私はイベントごとに異なるコマンドを登録したい(例: 完了時は通知、エラー時はログ)。単一コマンドの分岐をスクリプト側に書きたくない。

## Acceptance Criteria(Gherkin)

### 主要

```gherkin
Feature: イベントに応じたコマンド実行

  Scenario: 登録済みイベントでコマンドが実行される
    Given opencode.json にイベント "session.idle" とコマンド "/usr/bin/notify-send" が登録されている
    When OpenCode が "session.idle" イベントを発生させる
    Then コマンド "/usr/bin/notify-send" が 1 回だけ実行される

  Scenario: プレースホルダーが実際の値に置換される
    Given イベント "session.created" に args ["{event}", "{sessionID}"] を持つコマンドが登録されている
    When "session.created" イベントが sessionID "ses_abc123" で発生する
    Then コマンドは引数 ["session.created", "ses_abc123"] で実行される

  Scenario: 未登録のイベントでは何も実行されない
    Given opencode.json に "session.idle" のコマンドのみが登録されている
    When OpenCode が "session.text.delta" など未登録のイベントを発生させる
    Then いかなるコマンドも実行されず、エラーも発生しない

  Scenario: 欠落フィールドのプレースホルダーはリテラルで渡される
    Given イベント "session.idle" に args ["{agent}"] を持つコマンドが登録されている
    When "session.idle" イベントが発生する(data に agent はない)
    Then コマンドは引数 ["{agent}"] で実行される

  Scenario: 1 イベントに複数のコマンドが並行実行される
    Given イベント "session.idle" に 2 つのコマンドが登録されている
    When "session.idle" イベントが発生する
    Then 2 つのコマンドがともに実行される(順序保証なし)
```

### 例外・堅牢性

```gherkin
  Scenario: コマンド実行が失敗しても OpenCode 本体は継続する
    Given 登録されたコマンドのパスが存在しない、または終了コード非ゼロで終わる
    When 登録済みイベントが発生する
    Then OpenCode の動作(セッション処理・他イベント処理)は影響を受けず続行する
    And 失敗の事実(コマンド・終了コード・エラー出力の先頭 4 KiB)が実行ログに記録される

  Scenario: タイムアウトでコマンドが強制終了される
    Given ルールに timeoutMs 1000 が設定され、登録されたコマンドが 1 秒以内に終了しない
    When 登録済みイベントが発生する
    Then コマンドは強制終了される
    And OpenCode のイベント処理は待たされない
    And タイムアウトの事実(コマンド・所要時間)が実行ログに記録される

  Scenario: 構造不正なルールは無効化され OpenCode は起動継続する
    Given opencode.json のあるルールが event フィールドを欠く
    When OpenCode が起動する
    Then OpenCode は起動し続け、当該ルールは実行されない
    And 警告が実行ログに記録され、stderr に 1 行出力される
```

## NFR(非機能要件)

| 観点 | 要件 |
|---|---|
| 性能 | コマンド実行の待ち時間が OpenCode 本体のイベント処理・セッション処理をブロックしないこと(fire-and-forget)。登録されていないイベントの処理は無視するだけにとどまること。 |
| コスト | プラグインの動作に追加の外部サービス・常駐プロセスを必要としないこと。依存は最小限に保つこと。 |
| セキュリティ | プレースホルダー置換後の値はコマンドの引数(argv)として扱われ、シェルによる再解釈が行われないこと。実行コマンドは OpenCode を実行しているユーザー権限で動く旨と、信頼できるコマンドのみ登録すべき旨をドキュメントに明記すること。 |
| 監査 | 「いつ・どのイベント・どのコマンド・終了コード(失敗時はエラー内容)」を実行ログ(JSONL)で確認できること。設定内容は起動時の実行ログ列挙で確認できること。 |
| 運用 | macOS / Linux / Windows で動作すること。プラグイン自身の異常(設定パース失敗、コマンド起動失敗を含む)で OpenCode 本体が異常終了しないこと。設定ミスの場合でも OpenCode が起動し続けること(該当ルールの無効化 + 警告)。 |
| 互換性 | OpenCode v2 のイベントタイプ名をそのまま用い、プラグイン独自の抽象イベント名を導入しないこと。v2 でイベントタイプが追加されても、既存の設定を壊さないこと(未知のイベントタイプ名はユーザーが登録した範囲でだけ意味を持つ)。 |

## 配布(確定)

- npm パッケージ名: `opencode-event-exec`(スコープなし)。
- バージョニング: `0.1.0` スタート(semver、安定版で `1.0.0`)。
- 実装形式: promise 型プラグイン(`{ id, setup(context) }` 形式の default export)。

## 実装時に検証する技術事項(仕様確定済み・手段は未検証)

- Windows でのタイムアウト強制終了の具体手段(プロセスツリー kill)。
- 実行ログの時刻表現(ISO 8601 想定)と JSONL のフィールド名。
- `~/.local/share` 解決の自前実装と本体(`global-roots.ts`)の追従方法。

## 将来の後方互換追加候補(本バージョンでは対象外)

- スパム抑制(`minDuration` / `suppressWhenFocused` 相当)。
- ルールごとの `cwd` 指定。
- 登録内容を一覧するカスタムコマンド。
- 同時実行数の上限・直列化・スキップ。

## 変更履歴

- v2(2026-09-26): grill-with-docs セッションで全 Open Questions を解消。プレースホルダーを 6 種に確定(`{timestamp}` を `{created}` に改名、`{data}` 追加、欠落時リテラル透過)。設定スキーマ・タイムアウト・実行ログ(JSONL・パス・切詰め)・設定検証・配布形態を確定。`session.idle` 非推奨の事実を反映。決定の経緯は `docs/adr/0001`〜`0004`。
- v1(2026-09-26): 初稿。
