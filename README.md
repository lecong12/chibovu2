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

Sau khi đăng nhập, mở **Cập nhật / tải tài liệu lên** để thêm PDF mới hoặc thay thế một tài liệu hiện có. Tệp được giới hạn tối đa 25 MB; tài liệu mới được đưa vào danh mục đã chọn. Bản thay thế và tệp mới được lưu trong bucket riêng tư và vẫn còn sau khi deploy. PDF hiện có trong `private-documents/` tiếp tục được dùng làm dữ liệu ban đầu; bản trong bucket sẽ được ưu tiên khi có cùng đường dẫn.

### Cấu hình Cloudflare R2

Tạo bucket R2 riêng tư và API token giới hạn trong bucket đó, có quyền liệt kê bucket và đọc/ghi/xóa object. Thêm các biến sau trong **Vercel → Project → Settings → Environment Variables**:

- `S3_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `S3_BUCKET`: tên bucket
- `S3_REGION`: `auto`
- `S3_ACCESS_KEY_ID`: Access Key ID của token R2
- `S3_SECRET_ACCESS_KEY`: Secret Access Key của token R2

Trong cấu hình CORS của bucket, chỉ cho phép origin của website (ví dụ `https://chibovu2.vercel.app`), phương thức `PUT`, và các request header `content-type`, `x-amz-meta-target-path`, `x-amz-meta-expected-size`. Khi phát triển cục bộ bằng `vercel dev`, thêm origin localhost tương ứng. Không bật truy cập công khai cho bucket. Có thể đặt lifecycle tự xóa object trong tiền tố `pending/` sau một ngày để dọn các lượt upload bị bỏ dở. Sau khi cấu hình, deploy lại ứng dụng.

Với Amazon S3, đặt `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` và để `S3_ENDPOINT` trống. Dùng quyền IAM giới hạn trong bucket này (`ListBucket`, `GetObject`, `PutObject`, `DeleteObject`); cấu hình CORS tương tự để website được phép `PUT`.

Nếu chưa cấu hình kho lưu trữ, website vẫn đọc các PDF đã đóng gói như trước nhưng tính năng upload sẽ báo chưa được cấu hình. Liên kết upload có thời hạn ngắn; máy chủ xác minh chữ ký PDF trước khi đưa tệp vào danh sách tài liệu.
