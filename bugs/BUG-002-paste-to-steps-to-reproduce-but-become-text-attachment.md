# [BUG-002] Paste to Steps to Reproduce but become text attachment

| Field | Value |
|-------|-------|
| **Status** | `[x] Done` |
| **Reported by** | CS |
| **Date** | 2026-06-14 12:22 |
| **Severity** | 🟡 Medium |
| **Page/Route** | `N/A` |
| **Browser** | Chrome |
| **Device** | Desktop |

---

## Steps to Reproduce

1. click new bug
2. click "Steps to Reproduce" to focus on the text input box
3. paste text from cache, but found it becomes an attachment

---

## Expected Behavior

The paste text should be filled in the focused text input, only when Attachments is focus, the paste should become an attachment

---

## Actual Behavior

> What actually happens

## Screenshots

![Screenshot](screenshots/BUG-002-data-2026-06-14T12-07-17.txt)


---

## Suggested Fix

<!-- None provided -->

---

## Eva2 Notes

| Field | Value |
|-------|-------|
| **Fix commit** | (local) |
| **Resolution** | Global paste listener now checks if the target is the drop-zone before creating an attachment. Regular text inputs and textareas handle their own paste naturally. |
| **Time spent** | 5 min |
