# PickFix privacy policy

*Last updated: 3 October 2026* · [Tiếng Việt](#chính-sách-quyền-riêng-tư-của-pickfix)

PickFix is two pieces of software that run on your own computer: the PickFix browser extension and the `pickfix-mcp` server. This policy covers both.

## Summary

- PickFix has no servers, no accounts and no analytics. We never receive your data.
- The extension sends data to exactly one place: the `pickfix-mcp` server running on your own machine, at `127.0.0.1`.
- The server hands that data to the coding agent you run (for example Claude Code). From there, your agent may send it to its AI model provider as part of your conversation, under your agreement with that provider.

## What the extension collects, and when

Nothing is collected until you act on a page. The extension runs on local development servers (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) and on other sites only after you allow them.

| When you… | PickFix keeps |
|---|---|
| Pick an element | Your comment; the page URL and title; the element's tag, selector, text, attributes, a short HTML excerpt and key styles; where it lives in your source code; a screenshot of the element |
| Rewrite text in place | The text before and after your edit |
| Add a page comment | Your comment and the page URL |
| Record a workflow | Clicks, typed values, selections, key presses and page changes; console errors and failed network requests on that page while recording |

Values of password fields, payment-card fields, one-time codes and elements marked `data-pickfix-mask` are replaced with `••••` before they are stored. Even so, record with test data rather than real customer data.

## Where it is stored

- **In the extension:** drafts and settings are kept in your browser's extension storage on your computer. Deleting a draft or removing the extension removes them.
- **In `pickfix-mcp`:** feedback you send is kept under `~/.pickfix/queue` on your computer until it is handled. Finished feedback is deleted after 7 days.

## Who receives it

- **The PickFix authors:** nobody. PickFix makes no network requests to any server we run, and contains no tracking or advertising code.
- **Your coding agent:** when you press **Send to Claude** (or import an export file), the feedback becomes part of your agent's session. Agents such as Claude Code send conversation content to their model provider. That transfer is governed by your agreement with that provider, not by PickFix.
- **Nobody else.** We do not sell, rent or share data, and we do not use it for advertising, credit decisions or any purpose other than getting your feedback to your coding agent.

## Permissions

The extension asks only for what this needs: storage for drafts and settings, scripting and active-tab access to show the picker and take element screenshots on the tab you choose, and access to local development hosts. Access to any other site is optional and requested only when you turn PickFix on there.

## Your choices

- Delete any draft from the panel.
- Delete `~/.pickfix` to remove everything the server stored.
- Remove the extension to delete everything it stored in your browser.

## Changes and contact

If this policy changes, the new version will be published here with a new date. Questions: open an issue at <https://github.com/ledutu-studio/pickfix-mcp/issues>.

---

# Chính sách quyền riêng tư của PickFix

*Cập nhật lần cuối: 03/10/2026* · [English](#pickfix-privacy-policy)

PickFix gồm hai phần mềm chạy trên chính máy tính của bạn: extension trình duyệt PickFix và server `pickfix-mcp`. Chính sách này áp dụng cho cả hai.

## Tóm tắt

- PickFix không có server, không có tài khoản, không có analytics. Chúng tôi không bao giờ nhận dữ liệu của bạn.
- Extension chỉ gửi dữ liệu tới đúng một nơi: server `pickfix-mcp` chạy trên máy bạn, tại `127.0.0.1`.
- Server chuyển dữ liệu đó cho coding agent bạn đang chạy (ví dụ Claude Code). Từ đó, agent có thể gửi nó tới nhà cung cấp mô hình AI như một phần cuộc hội thoại, theo thoả thuận giữa bạn và nhà cung cấp đó.

## Extension thu thập gì, khi nào

Extension không thu thập gì cho tới khi bạn thao tác trên trang. Extension chạy trên các dev server cục bộ (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), và chỉ chạy trên trang khác sau khi bạn cho phép.

| Khi bạn… | PickFix lưu |
|---|---|
| Chọn một phần tử | Ghi chú của bạn; URL và tiêu đề trang; tag, selector, nội dung chữ, thuộc tính, một đoạn HTML ngắn và các style chính của phần tử; vị trí của nó trong source code; ảnh chụp phần tử |
| Sửa chữ trực tiếp | Nội dung trước và sau khi sửa |
| Thêm ghi chú trang | Ghi chú của bạn và URL trang |
| Ghi thao tác | Các cú click, giá trị đã nhập, lựa chọn, phím bấm và chuyển trang; lỗi console và request mạng thất bại trên trang đó trong lúc ghi |

Giá trị của ô mật khẩu, ô thẻ thanh toán, mã dùng một lần và các phần tử có `data-pickfix-mask` được thay bằng `••••` trước khi lưu. Dù vậy, hãy ghi thao tác bằng dữ liệu test thay vì dữ liệu thật của khách hàng.

## Lưu ở đâu

- **Trong extension:** bản nháp và cài đặt nằm trong bộ nhớ extension của trình duyệt trên máy bạn. Xoá bản nháp hoặc gỡ extension sẽ xoá chúng.
- **Trong `pickfix-mcp`:** feedback bạn gửi được lưu trong `~/.pickfix/queue` trên máy bạn cho tới khi được xử lý. Feedback đã xong bị xoá sau 7 ngày.

## Ai nhận dữ liệu

- **Tác giả PickFix:** không ai cả. PickFix không gửi request tới bất kỳ server nào của chúng tôi, và không chứa mã theo dõi hay quảng cáo.
- **Coding agent của bạn:** khi bạn bấm **Gửi cho Claude** (hoặc import file đã xuất), feedback trở thành một phần phiên làm việc của agent. Các agent như Claude Code gửi nội dung hội thoại tới nhà cung cấp mô hình. Việc đó tuân theo thoả thuận giữa bạn và nhà cung cấp, không thuộc PickFix.
- **Không ai khác.** Chúng tôi không bán, cho thuê hay chia sẻ dữ liệu, và không dùng nó cho quảng cáo, xét tín dụng hay bất kỳ mục đích nào ngoài việc đưa feedback của bạn tới coding agent.

## Quyền truy cập

Extension chỉ xin những quyền cần cho việc này: bộ nhớ cho bản nháp và cài đặt; quyền chạy script và quyền với tab đang mở để hiện công cụ chọn và chụp ảnh phần tử trên tab bạn chọn; và quyền với các host phát triển cục bộ. Quyền với trang khác là tuỳ chọn, chỉ được xin khi bạn bật PickFix trên trang đó.

## Lựa chọn của bạn

- Xoá bản nháp bất kỳ trong panel.
- Xoá thư mục `~/.pickfix` để xoá mọi thứ server đã lưu.
- Gỡ extension để xoá mọi thứ extension đã lưu trong trình duyệt.

## Thay đổi và liên hệ

Nếu chính sách thay đổi, bản mới sẽ được đăng tại đây kèm ngày cập nhật. Câu hỏi: mở issue tại <https://github.com/ledutu-studio/pickfix-mcp/issues>.
