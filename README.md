# opencode-event-exec

OpenCode v2 の公開イベントストリーム(`context.event.subscribe()`)を購読し、`opencode.json` に登録したイベントタイプ名と完全一致するイベントが到着したときに、登録したコマンドを実行するプラグイン。イベントタイプ名の完全一致だけで動作し、ワイルドカード・抽象イベント名・ペイロード条件は扱わない。

## 動作環境

- Node.js 20 以上

## 手元での確認手順

### 1. ビルドとテスト

```sh
npm install
npm run build
npm test
```

### 2. tarball の生成

```sh
npm pack
```

カレントディレクトリに `opencode-event-exec-0.1.0.tgz` が生成される。

### 3. OpenCode v2 へのローカルインストール

生成した tarball を `file:` の絶対パスで指定し、`opencode.json` の `plugins` に登録する。OpenCode はこの指定を npm パッケージとしてインストールして読み込む。

```json
{
  "plugins": [
    {
      "package": "file:/absolute/path/to/opencode-event-exec-0.1.0.tgz",
      "options": {
        "rules": [
          {
            "event": "session.idle",
            "command": "/usr/bin/notify-send",
            "args": ["opencode", "session idle"]
          }
        ]
      }
    }
  ]
}
```

- `package`: 生成した tarball の絶対パスを `file:` に続けて書く。
- `options.rules[].event`: OpenCode v2 のイベントタイプ名。登録した名前と完全一致するイベントだけが対象になる。
- `options.rules[].command`: 実行するファイル。シェルを介さずに起動される。
- `options.rules[].args`: 省略可能な文字列配列。次の 6 種のプレースホルダーはイベントの実フィールド値に置換される。
  - `{event}`: イベントタイプ名
  - `{sessionID}`: `data.sessionID`(文字列のとき)
  - `{agent}`: `data.agent`(文字列のとき)
  - `{model}`: `data.model`(文字列のとき)
  - `{created}`: トップレベルの `created`(数値のとき、エポックミリ秒の文字列)
  - `{data}`: `data` 全体(null でない object のとき、compact JSON 文字列)
- 参照先がイベントに存在しない場合、空文字列には置換せず `{agent}` のようなリテラル文字列のまま引数に渡る。
- プレースホルダーの置換は `args` の各要素だけに適用され、`command` には適用しない。

`options.rules[].command` に登録したコマンドは、OpenCode を実行しているユーザーの権限で実行される。信頼できるコマンドのみを登録すること。

### 4. 確認ポイント

OpenCode v2 を起動し、次を確認する。

1. 登録済みのイベントタイプ名(例: `session.idle`)が発生すると、対応するコマンドが 1 回だけ実行される。
2. 登録していないイベントタイプ名では、何も実行されずエラーも警告も出ない。
3. 登録したコマンドの起動に失敗した場合(実行ファイルが存在しない等)、OpenCode 側の stderr に次の 1 行が出力される。

```
opencode-event-exec: failed to spawn <command>: <理由>
```

起動に成功したコマンドと、終了コードが非ゼロのコマンドでは、stderr に何も出力されない。

4. `args` にプレースホルダーを書いたルールでは、イベントが持つ実フィールド値(例: `session.created` の `data.sessionID`)に置換されてコマンドが実行される。参照先がないプレースホルダーは `{agent}` のリテラルのまま渡る。
