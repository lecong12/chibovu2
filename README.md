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

Thêm PDF vào `private-documents/` (có thể phân thư mục theo năm). Các liên kết chưa có tệp sẽ tự chuyển thành trạng thái “Chưa cập nhật”. `vercel.json` giữ thư mục này ngoài thư mục public và đưa nội dung vào các hàm cần dùng; không chuyển PDF trở lại `public/` hoặc `assets/`.

Phiên đăng nhập được ký phía máy chủ, lưu trong cookie `HttpOnly`, `Secure`, `SameSite=Strict` và hết hạn sau 8 giờ. Đổi `SESSION_SECRET` để thu hồi tất cả phiên đang tồn tại. Đây là một tài khoản dùng chung; hãy cấu hình giới hạn tốc độ cho `/api/login` bằng Vercel Firewall nếu triển khai công khai.

Nếu bản cũ từng được triển khai công khai, hãy thay thông tin đăng nhập cũ và xem các tài liệu đã từng nằm trong thư mục public là có thể đã bị truy cập.

## Upload và cập nhật tài liệu

Sau khi đăng nhập, mở **Cập nhật / tải tài liệu lên** để thêm PDF mới hoặc thay thế tài liệu hiện có. Tệp tối đa 25 MB được chia thành các phần nhỏ, gửi qua API đã xác thực và lưu trong MongoDB GridFS. Tài liệu upload vẫn tồn tại sau khi deploy. PDF có sẵn trong `private-documents/` vẫn được dùng như trước; bản lưu trong MongoDB được ưu tiên nếu có cùng đường dẫn.

### Cấu hình MongoDB Atlas

1. Tạo cluster trong [MongoDB Atlas](https://www.mongodb.com/atlas) và tạo database user có quyền `readWrite` trên database của website.
2. Trong **Network Access**, cho phép kết nối từ Vercel. Nếu dự án không có static outbound IP, có thể cần cho phép `0.0.0.0/0`; khi đó hãy dùng mật khẩu mạnh, chỉ cấp quyền `readWrite` trên database này và không dùng database user cho mục đích khác.
3. Lấy connection string dạng `mongodb+srv://...` từ **Connect → Drivers**. Thay thông tin user/password và tên database; encode ký tự đặc biệt trong user/password theo URL.
4. Trong **Vercel → Project → Settings → Environment Variables**, thêm:
   - `MONGODB_URI`: connection string Atlas (đánh dấu là Secret).
   - `MONGODB_DATABASE`: tên database, ví dụ `chibovu2`.
5. Redeploy project trên Vercel để các biến có hiệu lực.

Không đặt connection string trong mã nguồn và không gửi URI hoặc mật khẩu database qua chat. Ứng dụng tự tạo các collection GridFS (`fs.files`, `fs.chunks`) cùng collection tạm cho upload; các phần upload dở sẽ được tự dọn sau 24 giờ. Tệp được gửi theo từng phần 2 MB để phù hợp giới hạn request của Vercel. Nếu chưa cấu hình MongoDB, website vẫn đọc PDF đóng gói nhưng chức năng upload sẽ báo chưa được cấu hình.
