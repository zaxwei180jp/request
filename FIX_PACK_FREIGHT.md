# 🔧 修正 pack.html 和 freight.html

## ✅ 已修正的問題

### pack.html（出貨單）
- ✅ 修正 badge 調用，添加 STATUS_MAP_PACK
- ✅ 修正 scls 調用，添加 STATUS_MAP_PACK  
- ✅ 修復按鈕 onclick XSS 風險，改用事件委派
- ✅ 添加事件委派邏輯處理按鈕點擊

### freight.html（運費單）
- ✅ 路徑已正確

---

## 📱 手機上傳步驟

### 第一步：更新 pack.html

1. 打開 GitHub：https://github.com/你的帳號/request-main
2. 進入 `public/pack.html`
3. 按右上角 ✏️ 編輯
4. 使用提供的新版本替換全部內容
5. Commit message：`fix: correct STATUS_MAP_PACK usage and add event delegation`

### 第二步：清除快取

上傳完後：
1. 等 2-3 分鐘 Vercel 部署
2. 回到網頁（出貨單頁面）
3. **長按刷新按鈕** → **清除快取並硬重新載入**
4. 或者關掉 Safari，重新打開

---

## ⚠️ 重要：完全清除快取

如果還是看不到資料，試試：

1. **設定 → Safari → 進階**
2. **網站資料**
3. 找 `request-teal-eight.vercel.app` 
4. **編輯 → 刪除**
5. 重新打開網頁

或者：
```
完全關閉 Safari
Home 按鈕連點 2 下關掉背景應用
重新打開 Safari
```

---

## ✅ 測試清單

重新整理後檢查：

**出貨單（pack.html）**
- [ ] 列表正常顯示（不再載入中）
- [ ] 有資料出現
- [ ] 能搜尋
- [ ] 能篩選狀態
- [ ] 能點擊出貨單看詳情
- [ ] 能點擊按鈕改變狀態

**運費單（freight.html）**
- [ ] 列表正常顯示
- [ ] 有資料出現
- [ ] 能搜尋
- [ ] 能篩選條件

---

## 💡 如果還有問題

1. **檢查 Console 有沒有紅色錯誤** （F12 → Console）
2. **檢查 Network 標籤** → 找 `/api/notion?action=pack_list` 請求
3. **看回覆內容** 有沒有資料

告訴我看到什麼錯誤 → 我可以快速修

---

## 📥 下載已修正的文件

如果你懶得手動編輯，直接用這些文件：

**新版 pack.html**：
```
/mnt/user-data/outputs/request-main-optimized/public/pack.html
```

**上傳方式**：
1. GitHub → public 文件夾
2. Add file → Upload files
3. 拖入新的 pack.html
4. Commit

---

**現在去上傳吧！應該馬上就能看到資料 🚀**
