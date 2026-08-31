# 安全密钥说明

此目录用于构建期签名，不会被 `electron-builder.yml` 打进正式安装包。

当前随包提供的是开发密钥，方便本地直接构建与验证流程。正式发布前必须替换为你自己的密钥，并且不要把私钥提交到公开仓库或发给第三方。

## 完整性清单签名

`build/after-pack-security.cjs` 会优先读取：

1. 环境变量 `HFM_INTEGRITY_PRIVATE_KEY_PEM`
2. 环境变量 `HFM_INTEGRITY_PRIVATE_KEY_FILE`
3. 默认文件 `build/security/hfm-integrity-private.pem`

客户端只内置完整性公钥，打包后会验证：

- `resources/security-integrity.json`
- `resources/security-integrity.sig`
- `resources/app.asar`
- `resources/native/*.exe`
- `resources/app.ico`

## License 签名

`create-license.cjs` 会优先读取：

1. 环境变量 `HFM_LICENSE_PRIVATE_KEY_PEM`
2. 环境变量 `HFM_LICENSE_PRIVATE_KEY_FILE`
3. 默认文件 `build/security/hfm-license-private.pem`

生成示例：

```bash
node build/security/create-license.cjs --edition pro --features batch_activation,shared_tags,nas_shared_library,advanced_index --device current --out license.json
```

生成的 license 文件可以放到用户数据目录：

```text
<userData>/license/license.json
```

也可以通过环境变量临时指定：

```bash
HFM_LICENSE_FILE=O:\\path\\license.json
```
