# 暖灯与失语之森

`editable/` 是完整主线三章加潮声海湾支线的可编辑权威源。
`warm-lantern-1.0.0.fmbook` 保留第一章历史版本，`warm-lantern-2.0.0.fmbook`
保留 H5-03 的三章历史版本，`warm-lantern-3.0.0.fmbook` 保留潮声海湾支线版本；
`warm-lantern-4.0.0.fmbook` 是“溪桥之夜”样片，增加窗边逐句演出、留灯/携灯路线、
营火回收和首回合开局差异，可由账号书架直接安装。对白中的说话者 `旅伴` 由游戏映射为
当前带队伙伴；第二章 `菲妮` 节点使用内容声明的立绘身份，并在剧情中解锁账号级伙伴。
潮声海湾节点显式声明 `sceneId` 与 `costumeId`，离开海滩后切回 `summer-travel`。

`warm-lantern-4.0.0.fmbook` SHA256：
`8b9189490369d2918bcd3baa135613f98dc95a7ef07c15e87598feba7a9ddd6f`。

在 `editable/` 目录重建成品包：

```sh
zip -q -X -r ../warm-lantern-4.0.0.fmbook manifest.json vocabulary.tsv \
  bindings.json story.json cards.json encounters.json characters.json assets.json
```

`script/` 是可读的逐章作者稿；成品包只收录运行时读取的八个核心文件。成品包按
Git LFS 管理；修改 JSON/TSV 后先重新打包，再通过账号页预览和安装验证。
