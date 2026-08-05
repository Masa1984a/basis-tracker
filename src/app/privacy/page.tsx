import type { Metadata } from "next";

// Even Hub のストア審査は、申請する権限すべてを説明したプライバシーポリシーの
// 公開URLを要求する。Even G2 アプリ "Basis DRR" が申請するのは network のみ。
// 英日併記なのは app.json の supported_languages が en/ja のため。

export const metadata: Metadata = {
  title: "Privacy Policy — Basis DRR for Even G2",
  description:
    "Privacy policy for the Basis DRR app for Even Realities G2 smart glasses.",
};

const UPDATED = "2026-08-05";
const CONTACT = "https://github.com/Masa1984a/even-g2-basis/issues";

export default function PrivacyPage() {
  return (
    <div style={{ padding: "24px 16px", maxWidth: 760, margin: "0 auto" }}>
      <section className="panel">
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>
          Privacy Policy — Basis DRR for Even G2
        </h1>
        <p className="dim" style={{ fontSize: 13, margin: "0 0 24px" }}>
          Last updated: {UPDATED}
        </p>

        <div lang="en">
          <h2>English</h2>
          <p>
            <strong>Basis DRR</strong> is an app for Even Realities G2 smart glasses
            that displays daily staking reward rates (DRR) for BTC, ETH, PAXG and SOL.
          </p>

          <h3>What we collect</h3>
          <p>
            <strong>Nothing.</strong> The app has no user accounts, no analytics, no
            tracking, and no advertising. We do not collect, store, transmit or share
            any personal information. Nothing you do in the app is sent to us or to
            any third party.
          </p>

          <h3>Permissions we request</h3>
          <p>
            The app requests one permission:
          </p>
          <ul>
            <li>
              <strong>network</strong> — used only to fetch publicly available reward
              rate data from <code>basis-tracker-smoky.vercel.app/api/drr</code>. This
              is a read-only request for aggregate market data. It sends no credentials,
              no cookies, and no information that identifies you or your device.
            </li>
          </ul>
          <p>
            The app requests no other permission. It does not access location, camera,
            album, or any microphone.
          </p>

          <h3>Data stored on your device</h3>
          <p>
            The app saves the most recently fetched reward rate data and which screen
            you were viewing, using the local storage of the Even Realities App. This
            lets the display come back instantly after your phone is locked. This data
            stays on your device, is never transmitted, and is removed when you
            uninstall the app.
          </p>

          <h3>Third parties</h3>
          <p>
            The app contacts only the domain listed above, which is operated by the
            developer of this app. No third-party service receives any data from the
            app. The data returned is public market information and is not specific
            to any user.
          </p>

          <h3>Children</h3>
          <p>
            The app is not directed at children and collects no information from
            anyone, including children.
          </p>

          <h3>Changes</h3>
          <p>
            If this policy changes, the &ldquo;Last updated&rdquo; date above will
            change with it.
          </p>

          <h3>Contact</h3>
          <p>
            Questions about this policy:{" "}
            <a href={CONTACT} target="_blank" rel="noopener noreferrer">
              {CONTACT}
            </a>
          </p>

          <h3>Disclaimer</h3>
          <p>
            The app displays historical staking reward rates for informational
            purposes only. It is not financial advice.
          </p>
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--line, #232a33)", margin: "32px 0" }} />

        <div lang="ja">
          <h2>日本語</h2>
          <p>
            <strong>Basis DRR</strong> は、BTC・ETH・PAXG・SOL
            の日次ステーキング報酬率(DRR)を Even Realities G2
            スマートグラスに表示するアプリです。
          </p>

          <h3>収集する情報</h3>
          <p>
            <strong>ありません。</strong>{" "}
            本アプリはユーザー登録、アクセス解析、トラッキング、広告のいずれも行いません。
            個人情報を収集・保存・送信・共有することは一切ありません。
            アプリ内での操作が開発者や第三者に送信されることもありません。
          </p>

          <h3>申請する権限</h3>
          <p>本アプリが申請する権限は1つだけです。</p>
          <ul>
            <li>
              <strong>network</strong> —{" "}
              <code>basis-tracker-smoky.vercel.app/api/drr</code>{" "}
              から公開された報酬率データを取得するためだけに使用します。
              集計済みの市場データを読み取るだけのリクエストであり、
              認証情報・Cookie・利用者や端末を識別する情報は一切送信しません。
            </li>
          </ul>
          <p>
            これ以外の権限は申請しません。位置情報、カメラ、アルバム、
            マイクにはアクセスしません。
          </p>

          <h3>端末内に保存されるもの</h3>
          <p>
            直近に取得した報酬率データと、表示していた画面を Even Realities App
            のローカルストレージに保存します。
            スマートフォンをロックした後でも表示をすぐ復帰させるためです。
            これらは端末内に留まり、送信されることはなく、
            アプリをアンインストールすると削除されます。
          </p>

          <h3>第三者提供</h3>
          <p>
            本アプリが通信するのは上記のドメインのみで、これは本アプリの開発者が運営しています。
            第三者のサービスにデータが渡ることはありません。
            取得するデータは公開された市場情報であり、特定の利用者に紐づくものではありません。
          </p>

          <h3>子どもの利用について</h3>
          <p>
            本アプリは子どもを対象としたものではなく、
            子どもを含むいかなる利用者からも情報を収集しません。
          </p>

          <h3>変更について</h3>
          <p>本ポリシーを変更した場合は、上部の最終更新日を更新します。</p>

          <h3>連絡先</h3>
          <p>
            本ポリシーに関するお問い合わせ:{" "}
            <a href={CONTACT} target="_blank" rel="noopener noreferrer">
              {CONTACT}
            </a>
          </p>

          <h3>免責</h3>
          <p>
            本アプリが表示するのは過去のステーキング報酬率であり、情報提供のみを目的としています。
            投資助言ではありません。
          </p>
        </div>
      </section>
    </div>
  );
}
