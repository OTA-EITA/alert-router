# alert-router

[![ci](https://github.com/OTA-EITA/alert-router/actions/workflows/ci.yml/badge.svg)](https://github.com/OTA-EITA/alert-router/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OTA-EITA/alert-router/badge)](https://securityscorecards.dev/viewer/?uri=github.com/OTA-EITA/alert-router)

Alertmanager の webhook を受けて、**ラベルに応じて Slack のチャンネルに振り分ける** TypeScript 製の小さなサービスです（Hono + zod）。

Alertmanager の Slack 連携をそのまま使うと、チームごとの receiver とルートが Alertmanager の設定に積み上がり、メッセージの見た目も揃えにくくなります。alert-router は Alertmanager からは webhook 1 本で受け、振り分け・重複排除・Runbook へのリンクをまとめて引き受けます。

## できること

- **ラベルでの振り分け**: `match`（完全一致）と `match_re`（Alertmanager と同じく前後を固定した正規表現）で送り先を決める。上から順に評価し、`continue: true` なら次のルートも評価する。どれにも当たらなければ `default_receiver` へ送るので、アラートが黙って消えない
- **重複排除**: Alertmanager の再送（repeat_interval）やリトライ、冗長構成の Alertmanager からの二重送信を、送り先・fingerprint・状態ごとに `dedup_window` の間まとめる。解決（resolved）の通知は別扱いなので必ず届く
- **Runbook / Silence へのリンク**: `runbook_url` アノテーションがあればそれを、なければ `runbook_base_url` + アラート名（`KubePodCrashLooping` → `kube-pod-crash-looping`）をボタンにする。発生中のアラートには、ラベルを埋めた Silence 作成画面へのリンクも付ける
- **dry-run**: 実際の webhook ペイロードで、どこに何が送られるかを Slack に送らずに確認できる
- **メトリクス**: `/metrics` に受信数・送信結果・重複排除の件数を Prometheus 形式で出す

```text
$ alert-router route --config examples/config.yaml examples/alert.json
platform-page: 🔥 FIRING 1: KubePodCrashLooping
  - firing   KubePodCrashLooping a3f5c9e1b2d4f6a8
payments: 🔥 FIRING 1: KubePodCrashLooping
  - firing   KubePodCrashLooping a3f5c9e1b2d4f6a8
platform: ✅ RESOLVED 1: KubeDeploymentReplicasMismatch
  - resolved KubeDeploymentReplicasMismatch 7c1e2d3f4a5b6c7d
```

## 設定

```yaml
receivers:
  - name: platform-page
    slack:
      webhook_url_env: SLACK_PLATFORM_PAGE # URL は秘密情報なので、環境変数の名前だけを書く
      mention: "<!subteam^S0123456789>" # 発生時だけメンション
  - name: payments
    slack: { webhook_url_env: SLACK_PAYMENTS }
  - name: catch-all
    slack: { webhook_url_env: SLACK_CATCH_ALL }

routes:
  - match: { severity: critical }
    receiver: platform-page
    continue: true # 重大なものはオンコールに加えて担当チームにも
  - match_re: { namespace: "payments(-.*)?" }
    receiver: payments

default_receiver: catch-all
runbook_base_url: https://runbooks.example.com/alerts/
dedup_window: 10m
```

全体の例は [`examples/config.yaml`](examples/config.yaml) です。`alert-router check` で、設定の誤りと環境変数の設定漏れをまとめて確認できます（デプロイ前の CI や initContainer 向け）。

Alertmanager 側は webhook を 1 つ向けるだけです。

```yaml
receivers:
  - name: alert-router
    webhook_configs:
      - url: http://alert-router.monitoring.svc:9095/webhook
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/alert-router/token
```

## 使い方

```sh
alert-router serve   --config config.yaml           # ALERT_ROUTER_TOKEN（16 文字以上）が必要
alert-router check   --config config.yaml           # 設定と webhook URL の環境変数を検証
alert-router route   --config config.yaml alert.json [--json]   # dry-run（- で標準入力）
```

コンテナイメージは `ghcr.io/ota-eita/alert-router`（linux/amd64・arm64、SBOM と provenance つき）、Kubernetes のマニフェストは [`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) です。

## セキュリティの設計

- **認証**: `/webhook` は Bearer トークン必須（Hono の bearerAuth で定数時間比較）。トークンは 16 文字以上でないと起動しない
- **入力は信頼しない**: ペイロードは zod で検証し、本文は 1 MiB まで。ラベルやアノテーションは監視対象から来る値なので、Slack の制御文字（`<` `>` `&`）をエスケープし、`<!channel>` やリンクを埋め込まれないようにしている
- **送信先の制限**: webhook URL は `https://` かつ `allowed_webhook_hosts`（既定 `hooks.slack.com`）のホストだけ。リダイレクトは追わない。環境変数の設定ミスでアラートの内容が外部に送られるのを防ぐ
- **秘密情報を残さない**: 設定ファイルには環境変数の名前だけを書く。送信エラーのログにはホスト名だけを出し、webhook URL（トークンを含む）は出さない
- **再送の扱い**: 送信に失敗した送り先があれば 502 を返し、Alertmanager にリトライさせる。成功した送り先は重複排除で 2 回目を送らず、失敗した送り先だけが再送される
- **実行環境**: distroless・非 root・読み取り専用ファイルシステム・全 capability 削除・ServiceAccount トークンなし、NetworkPolicy で Alertmanager と Prometheus からの通信だけを許可。マニフェストは [kube-readiness](https://github.com/OTA-EITA/kube-readiness) でセキュリティ 100 点（レプリカ 1 の警告のみ。重複排除がプロセス内のため意図して 1）

## テスト

- 単体テスト（Vitest、カバレッジのしきい値つき）: ルーティング、重複排除、メッセージのエスケープ、送信のリトライ、HTTP の認証・検証・502 再送
- E2E（[`test/e2e/run.sh`](test/e2e/run.sh)）: CI で **本物の Alertmanager** からコンテナイメージの alert-router に送り、HTTPS の Slack モックに届くまでを確認。トークンなしの拒否、critical の 2 か所への配送、解決通知、メトリクスを検証

## 開発

```sh
npm ci --ignore-scripts
npm run coverage
npm run lint
npm run build      # dist/server.js（依存を含む 1 ファイル）
```

依存は公開から 7 日以上たった版だけで lockfile を作り（`npm install --before`）、CI で [lockfile-guard](https://github.com/OTA-EITA/lockfile-guard) と [gha-guard](https://github.com/OTA-EITA/gha-guard) を回しています。

## License

MIT
