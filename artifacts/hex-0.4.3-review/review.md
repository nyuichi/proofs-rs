# hex 0.4.3 掲載前レビュー

状態：掲載データを準備済みです。アップロードはまだ実行していません。

## 掲載する主張

`encode_to_slice` の正確な小文字16進表現と、`decode_to_slice` の大小混在の復号、エラー優先順位、最初の無効文字の位置、部分書き込み範囲について、注釈付きソースの実装本体を再検証しました。公開ラッパーは trusted な AsRef の契約を前提とします。

通常の `encode` / `encode_upper` / `ToHex` の文字列生成実装、serde、整形処理は今回の掲載主張から除外します。元の crates.io ソースそのものの無変更での証明や、元実装との機械検証済みの同値性は主張しません。

## 再検証結果

| 構成 | Creusot |
| --- | --- |
| no-default-features | Proved (21 files) |
| alloc only | Proved (26 files) |
| serde only | Proved (21 files) |
| all-features | Proved (26 files) |

これは証明ファイル数であり、証明義務の件数ではありません。クリーンなソース展開から実行し、既存リポジトリの生成物はコピーしていません。4構成の連続実行内では証明キャッシュを利用し得ます。

通常の全機能テスト：単体14件、serde結合4件、バージョン監査2件、ドキュメント11件、計31件成功です。依存先のCreusotメタデータが見つからない警告はありましたが、4構成とも終了コード0で証明成功を報告しました。

## 登録内容

- crate_name: `hex`
- crate_version: `0.4.3`
- upstream_repository: `KokaKiwi/rust-hex`
- upstream_commit: `b2b4370b5bf021b98ee7adc92233e8de3f2de792`
- upstream_path: ``
- verification_repository: `nyuichi/rust-crate-proofs`
- verification_commit: `3ecf33ddab79f30b840c4e3fe108b75101f92a36`
- verification_path: `hex/0.4.3`
- labels: `['functional correctness', 'encoding', 'decoding']`

## 掲載本文（英語、登録予定の原文）

Prove hex 0.4.3 slice encoding and decoding contracts with Creusot

Rechecked the annotated verification source at 3ecf33ddab79f30b840c4e3fe108b75101f92a36 in all four configurations: no default features, alloc only, serde only, and all features. Creusot reported 21, 26, 21, and 26 proved files respectively. These are file counts, not proof-obligation counts.

Scope: encode_to_slice produces exact lowercase hexadecimal output when the output length is exactly twice the input length; a length error leaves output unchanged. decode_to_slice accepts mixed-case digits, reports odd length before output-length mismatch, and otherwise reports the first invalid character and its index. On invalid input, complete preceding pairs are decoded and the remaining output suffix stays unchanged.

The slice implementation bodies and their public wrappers passed the integrated proof. Public generic inputs rely on the explicitly trusted AsRef byte-sequence bridge and on the pinned Creusot library specifications. The verification source rewrites the upstream slice loops into proof-friendly forms; this record does not establish a mechanically checked equivalence to every body in the unmodified crates.io release.

Excluded from this publication claim: the generic iterator-based encoding implementation underlying encode/encode_upper/ToHex, serde protocols, formatting, and arbitrary downstream trait implementations. Passing configurations do not prove these trusted boundaries.

Reproduction: run hex/0.4.3/verify-all.bash at the verification commit with nightly-2026-02-27 and the matching Creusot installation. The ordinary cargo test --offline --all-features run passed 14 unit, 4 serde integration, 2 version-audit, and 11 documentation tests. Rechecked on 2026-09-24 JST. Compiler metadata warnings were emitted; all four proof commands completed successfully.

## 添付SARIF

`hex-0.4.3.sarif.json` は4構成を4 runsとして記録し、各構成に3件の結果を含めます。対象APIは2つです。SARIFはソースと今回の実行ログに基づいて作成したもので、CreusotのネイティブSARIF出力ではありません。proofs.rsの実際の入力検証で、メタデータとSARIFの両方が受理されることを確認しました。

## 証跡

- verification.log：4構成の証明ログ
- tests.log：通常テストのログ
- environment.json：環境と実行バイナリのSHA-256
- Cargo.lock：今回解決した依存バージョン
- proof-evidence.tar.gz：生成した証明出力
- upstream-lib.diff：公式アーカイブとのlib.rs差分

登録予定はpublication.jsonのフィールドとSARIFです。ログ・証跡はこのリポジトリに保存しています。制約の詳細は LIMITATIONS.md、証跡の案内は README.md を参照してください。proofs.rsへの掲載は引き続き確認待ちです。
