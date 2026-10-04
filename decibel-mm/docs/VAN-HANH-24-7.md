# Vận hành bot 24/7 (hướng dẫn từng bước)

Tài liệu này dành cho máy ảo `decibel-mm` (GCP), người dùng `mm`, thư mục `/home/mm/TriangularArbitrageCrypto/decibel-mm`.
Mọi lệnh bên dưới chạy **trên máy ảo** (dấu nhắc `dunganh_hust47@decibel-mm`), không chạy trong Cloud Shell trần.

## 0. Hiểu trước khi chạy: bạn đang "mua" điểm với giá bao nhiêu

Mỗi USD khối lượng đều tốn chi phí cố định: phí sàn (maker 1,5 bps; rebate 0,5 bps chỉ về sau mỗi nửa tháng nếu giữ ≥ 80 % maker),
gas, và thiệt hại do bị khớp lúc giá chạy ngược (adverse selection). Lần đo trước (ETH, 1 giờ, mức 2,5 USD):
phí 1,78 bps + gas 1,78 bps + adverse selection ~1,2 bps − rebate 0,5 = **khoảng −4,3 bps** trên khối lượng.

**Khối lượng càng lớn thì số tiền mất tuyệt đối càng lớn nếu chi phí/USD không đổi.** Bản mới giảm chi phí trên mỗi USD
(lệnh to hơn nên gas/USD giảm, ít taker hơn, đo được gas từng loại giao dịch), nhưng không thể biến nó thành lãi.
Vì vậy có một con số bạn phải tự chọn: **`risk.maxDailyLossUsd` = số USD tối đa bạn chịu mất mỗi ngày để mua điểm.**

| Ngân sách/ngày | Khối lượng/ngày nếu chi phí 3 bps | Nếu chi phí 2 bps |
|---|---|---|
| 0,6 USD | ~2.000 USD | ~3.000 USD |
| 1,2 USD (mẫu) | ~4.000 USD | ~6.000 USD |
| 3 USD | ~10.000 USD | ~15.000 USD |

Các con số chi phí là ước tính từ 1 giờ đo cũ. Bot tự nới giá khi lỗ trong ngày chạy nhanh hơn nhịp ngân sách
(`maxPaceMult`), để ngân sách kéo dài cả ngày thay vì hết trong vài giờ. Chạm giới hạn: bot đóng vị thế, đứng ngoài đến hết ngày UTC
(07:00 giờ Việt Nam), rồi tự giao dịch lại.

## 1. Cập nhật mã trên máy ảo

```bash
sudo -u mm git -C /home/mm/TriangularArbitrageCrypto/decibel-mm pull origin claude/ecstatic-cray-akj7nm
D=/home/mm/TriangularArbitrageCrypto/decibel-mm/deploy
sudo cp $D/decibel-dashboard.service $D/decibel-dashboard-health.service $D/decibel-dashboard-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart decibel-dashboard
sudo systemctl enable --now decibel-dashboard-health.timer
curl -s "localhost:8787/healthz?deep=1"      # JSON: uptime, bộ nhớ, số dòng log, tuổi dòng log cuối
```

Khởi động lại dịch vụ dashboard **không** làm bot đang chạy dừng (`KillMode=process`). Bộ hẹn giờ `decibel-dashboard-health.timer`
kiểm tra `/healthz` mỗi phút và tự khởi động lại dashboard nếu nó treo (3 lần liền không trả lời). Xem trạng thái:
`systemctl status decibel-dashboard decibel-dashboard-health.timer --no-pager`.

### Mở dashboard ổn định từ máy Windows (khuyên dùng thay Cloud Shell)

Cloud Shell hết phiên là mất đường hầm, địa chỉ xem trước đổi, và trình duyệt quên mã điều khiển. Dùng đường hầm từ chính máy bạn:

1. Cài Google Cloud CLI cho Windows: https://cloud.google.com/sdk/docs/install (mở "Google Cloud SDK Shell" sau khi cài), rồi `gcloud auth login`
   và `gcloud config set project <tên-dự-án-của-bạn>`. Windows 10/11 thường đã có sẵn OpenSSH client.
2. Chép file `decibel-mm/deploy/windows/dashboard-tunnel.bat` và `dashboard-tunnel.ps1` (cùng thư mục) về máy, bấm đúp vào `.bat`.
3. Cửa sổ đen hiện "Mo duong ham lan 1", vài giây sau trình duyệt tự mở `http://localhost:8787`. **Giữ cửa sổ đó mở.** Rớt mạng/ngủ máy thì
   nó tự mở lại đường hầm sau 3 giây; trang tự nối lại. Địa chỉ luôn là `http://localhost:8787` nên trình duyệt nhớ mã điều khiển.
4. Muốn lấy mã điều khiển lần đầu: trong "Google Cloud SDK Shell" chạy
   `gcloud compute ssh decibel-mm --zone=asia-southeast1-b --command="sudo cat /home/mm/TriangularArbitrageCrypto/decibel-mm/state/dashboard.token"`
   rồi dán vào ô "Mã điều khiển" (đừng chụp màn hình có mã).

Nếu trang hiện thanh đỏ "Mất kết nối tới dashboard server": đường hầm rớt hoặc dịch vụ đang khởi động lại; đừng làm gì, trang tự nối lại
(số liệu cũ vẫn hiện, mờ đi). Nếu thanh đỏ kéo dài trên 2 phút, kiểm tra trên máy ảo `systemctl status decibel-dashboard`.

## 2. Đặt cấu hình 24/7

```bash
sudo -iu mm
cd ~/TriangularArbitrageCrypto/decibel-mm
cp config.json config.json.bak.$(date +%Y%m%d)        # sao lưu cấu hình cũ
cp config.24x7.example.json config.json
nano config.json                                       # xem các số ở mục 3, sửa nếu muốn, Ctrl+O Enter Ctrl+X
set -a; . /etc/decibel-mm/env; set +a
node --import tsx src/cli.ts check config.json | head -80
```

Trong kết quả `check` đọc: `equity`, `signer.aptBalance` (APT của ví ký, cần đủ nhiều ngày gas), và với ETH/USD `minOrderUsd`
(phải nhỏ hơn mức mỗi lệnh ≈ vốn × 1,5 × 0,33 ≈ 10 USD).

## 3. Các số chính trong `config.json` (mẫu 24/7)

| Mục | Giá trị mẫu | Ý nghĩa |
|---|---|---|
| `sizing.leverage` | 1,5 | Vị thế tối đa = vốn × 1,5 (vốn 20 USD → 30 USD). Lệnh mỗi mức = 33 % của số đó. Vốn giảm thì tự nhỏ lại, nạp thêm thì tự to ra |
| `risk.maxDailyLossUsd` | 1,2 | Ngân sách mất tối đa mỗi ngày UTC (xem mục 0) |
| `risk.maxDrawdownUsd` | 4 | Lỗ tổng từ lúc bot khởi động quá mức này: bot tự dừng hẳn (cần người xử lý) |
| `risk.minEquityUsd` | 14 | Vốn dưới mức này: bot tự dừng hẳn. Bền qua các lần khởi động lại |
| `risk.maxGasAptPerDay` | 0,8 | Ngân sách gas mỗi ngày (APT). Chạy nhanh hơn nhịp thì bot đặt lại lệnh thưa hơn; hết thì nghỉ đến hôm sau |
| `points.costBudgetBps` | 3 | Mức chi phí/khối lượng bot được phép chịu trước khi nới giá |
| `fuse.haltMode` | `cooloff` | Cầu chì ngắt quá nhiều lần: nghỉ 1 giờ rồi chạy lại (thay vì dừng hẳn) |
| `execution.encrypted` | `auto` | Giao dịch mã hóa tốn gas gấp đôi (200 so với 100 octas). Chỉ đổi sang `off` sau khi đo (mục 6) |

## 4. Chạy thử, rồi chạy thật, rồi 24/7

Làm lần lượt, không bỏ bước. Mở dashboard như mọi lần (đường hầm + Web Preview, dán mã điều khiển).

1. **Chạy thử 15 phút:** nhập `15`, tick "chạy thử", bấm **Bắt đầu**. Không có giao dịch thật. Kiểm tra: không có thẻ đỏ,
   thẻ "Đặt lại lệnh & chi phí" có số liệu, `Giới hạn đang áp dụng` ≈ vốn × 1,5.
2. **Chạy thật 2 giờ:** bỏ tick chạy thử, nhập `120`, bấm **Bắt đầu**. Hết giờ bot tự đóng vị thế. Đọc thẻ chi phí
   (số lần đặt lại/giờ, gas bps, taker) và bảng "Kinh tế".
3. **Chạy 24/7:** tick ô **chạy liên tục 24/7** (không nhớ giữa các lần mở trang, phải tick mỗi lần) rồi bấm **Bắt đầu**.
   Bot chạy không giờ kết thúc, tự khởi động lại khi lỗi.

Dừng: bấm **Kết thúc & đóng vị thế** (hủy lệnh, đóng toàn bộ vị thế, thoát, không tự chạy lại).
Dừng khẩn không đóng vị thế: `touch state/KILL` (nhớ xóa file này trước lần chạy sau).

### Muốn bot tự chạy lại sau khi máy ảo khởi động lại (tùy chọn)

```bash
exit                                                   # thoát khỏi user mm, về user có sudo
sudo cp /home/mm/TriangularArbitrageCrypto/decibel-mm/deploy/decibel-mm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now decibel-mm
journalctl -u decibel-mm -n 30 --no-pager
```

Không bật dịch vụ này khi đang chạy bằng nút trên dashboard: chỉ được có một bot. Tắt hẳn: `sudo systemctl disable --now decibel-mm`
(`stop` hủy lệnh nhưng **giữ vị thế**; muốn đóng vị thế hãy bấm Kết thúc trên dashboard trước).

## 5. Kiểm tra mỗi ngày (2 phút)

1. Dashboard: nhãn "ĐANG CHẠY", chế độ 24/7 hiện "đã khởi động lại N lần" (N nhỏ).
2. Thẻ **Vốn**: Δ trong ngày so với ngân sách `maxDailyLossUsd`.
3. Thẻ **Đặt lại lệnh & chi phí**: gas bps, taker "do giá chạy tới", "APT đủ ~N ngày" (nạp thêm khi dưới 3 ngày).
4. File `data/daily.csv`: một dòng mỗi ngày UTC (khối lượng, phí, gas, vốn đầu/cuối ngày):
   `column -s, -t < data/daily.csv`
5. Bảng "Lịch sử phiên chạy": phiên "Lỗi, bot đã tự khởi động lại" lặp nhiều là dấu hiệu có sự cố (xem Sự kiện).

## 6. Đo xem mã hóa giao dịch có đáng tiền không (A/B)

Thẻ chi phí hiện `gas/tx: mã hóa … APT · thường … APT` khi cả hai loại đã được dùng. Cách đo: chạy 2 giờ với
`"encrypted": "auto"`, ghi gas bps và `pnlBps`; sửa thành `"off"`, chạy 2 giờ tương đương, so sánh. `off` nửa gas mỗi giao dịch nhưng
lệnh thay thế hiện công khai trước khi vào khối. Không đổi nếu chưa đo.

## 7. Khi có sự cố

| Dấu hiệu | Nghĩa là | Việc cần làm |
|---|---|---|
| "BOT TỰ DỪNG" + lý do drawdown / equity | Chạm giới hạn lỗ tổng | Xem Positions trong app; tìm hiểu nguyên nhân trước khi bắt đầu lại |
| Cảnh báo "giới hạn lỗ trong ngày" | Đã mất hết ngân sách ngày | Không cần làm gì, bot tự chạy lại ngày UTC mới |
| "Lỗi, bot đã tự khởi động lại" | Bot gặp lỗi/mất dữ liệu và được dựng lại | Xem bảng Sự kiện; nếu lặp lại nhiều lần mỗi giờ thì kiểm tra khóa API và mạng |
| Trạng thái giám sát "throttled" | Quá 8 lần khởi động trong 1 giờ: đã hủy lệnh, đang chờ để thử lại (mỗi giờ tối đa 8 lần) | Sửa nguyên nhân (khóa API, mạng, APT); nó tự chạy lại khi hết chờ, hoặc bấm Kết thúc để đóng vị thế |
| Giám sát thoát với mã 3 | Lệnh đóng vị thế bị lỗi, vị thế có thể còn mở | Mở Positions trong app, đóng tay nếu cần; file `state/STOP` được giữ lại để lần sau đóng tiếp |
| "APT trong ví ký chỉ đủ ~N ngày" | Sắp hết gas | Nạp APT vào ví ký (địa chỉ có trong `check` → `signer`) |
| Muốn biết còn lệnh treo không | | `node --import tsx src/cli.ts cancel config.json` hủy mọi lệnh và liệt kê lệnh còn lại |
| Thanh vàng "Trang (API vX) và tiến trình dashboard (API vY) khác phiên bản" | Đã cập nhật mã nhưng chưa khởi động lại dịch vụ | `sudo systemctl restart decibel-dashboard`, tải lại trang |
| Dashboard chậm hoặc ăn nhiều RAM | Hiếm: log quá lớn | `curl -s "localhost:8787/healthz?deep=1"` xem `rssMb`, `log.retained`; dashboard tự khởi động lại nếu RAM trên 700 MB quá 30 giây |
