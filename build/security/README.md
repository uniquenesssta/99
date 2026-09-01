# 安全密钥说明

此目录用于构建期签名，不会被 `electron-builder.yml` 打进正式安装包。

仓库只保留公钥，不包含任何私钥。私钥必须通过环境变量或本机被 `.gitignore` 排除的文件提供，不得提交到仓库或发给第三方。

任何曾进入 Git 历史的私钥都应视为已经泄露，不得继续用于正式签名；请生成新密钥并替换对应公钥。

正式发布前，必须替换为自己的完整密钥对，并运行 `npm run security:sync-keys` 将对应公钥同步到应用源码。私钥与仓库中的公钥不匹配时，打包结果无法通过客户端校验。

## 完整性清单签名

`build/after-pack-security.cjs` 会优先读取：

1. 环境变量 `HFM_INTEGRITY_PRIVATE_KEY_PEM`
2. 环境变量 `HFM_INTEGRITY_PRIVATE_KEY_FILE`
3. 本机文件 `build/security/hfm-integrity-private.pem`（已被 Git 忽略）

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
3. 本机文件 `build/security/hfm-license-private.pem`（已被 Git 忽略）

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
