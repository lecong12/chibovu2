# Chi bộ Vụ Địa phương 2

Trang tài liệu tĩnh được triển khai trên Vercel. Giao diện nằm trong `public/`; tài liệu PDF nằm trong `private-documents/` và chỉ được gửi bởi API sau khi xác thực.

## Cấu hình xác thực trên Vercel

Thêm các biến môi trường sau trong Vercel cho từng môi trường cần triển khai:

- `AUTH_USERNAME`: tên đăng nhập.
- `AUTH_PASSWORD`: mật khẩu mạnh, mới; không dùng lại thông tin đăng nhập cũ.
- `SESSION_SECRET`: chuỗi ngẫu nhiên tối thiểu 32 byte.

Có thể tạo secret bằng Node.js:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Không lưu các giá trị này trong mã nguồn. Sau khi thêm biến môi trường, triển khai lại ứng dụng. Khi phát triển cục bộ, đặt cùng ba biến trong môi trường rồi chạy `npx vercel dev`.

## Tài liệu

Thêm PDF vào `private-documents/` (có thể phân thư mục theo năm). Các liên kết chưa có tệp sẽ tự chuyển thành trạng thái “Chưa cập nhật”. `vercel.json` giữ thư mục này ngoài thư mục public và đưa nội dung vào hàm tài liệu; không chuyển PDF trở lại `public/` hoặc `assets/`.

Phiên đăng nhập được ký phía máy chủ, lưu trong cookie `HttpOnly`, `Secure`, `SameSite=Strict` và hết hạn sau 8 giờ. Đổi `SESSION_SECRET` để thu hồi tất cả phiên đang tồn tại. Đây là một tài khoản dùng chung; hãy cấu hình giới hạn tốc độ cho `/api/login` bằng Vercel Firewall nếu triển khai công khai.

Nếu bản cũ từng được triển khai công khai, hãy thay thông tin đăng nhập cũ và xem các tài liệu đã từng nằm trong thư mục public là có thể đã bị truy cập.
