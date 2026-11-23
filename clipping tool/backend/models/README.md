# Face detector model

CLIPFORGE's smart reframing uses OpenCV's YuNet face detector when it renders a
vertical clip. The expected default file is:

```text
backend/models/face_detection_yunet_2023mar.onnx
```

The model is small (about 233 KB) and is loaded locally by OpenCV; no frames are
sent to a third-party service for detection.

If the file is missing, download the same model from the OpenCV Zoo:

```bash
curl -L \
  -o backend/models/face_detection_yunet_2023mar.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

Expected SHA-256 for the bundled copy used during Phase 6 verification:

```text
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
```

To use another compatible local YuNet ONNX file, set:

```bash
CLIPFORGE_FACE_DETECTOR_MODEL=/absolute/path/to/model.onnx
```

If OpenCV is not installed, the model cannot be loaded, or no face is detected,
the backend does **not** claim face tracking. It renders a center-crop fallback
and stores `method: "center-crop-fallback"` on the reframe record.
