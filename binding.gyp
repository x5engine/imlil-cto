{
  "targets": [
    {
      "target_name": "imlil_gpu",
      "sources": [
        "src/gpu/binding.cc",
        "src/gpu/cuda/gpu_monitor.c",
        "src/gpu/cuda/agent_launcher.cu"
      ],
      "include_dirs": [
        "src/gpu/include",
        "<!(node -e \"require('node-api-headers')\")"
      ],
      "cflags": [],
      "conditions": [
        ["OS==\"linux\"", {
          "cflags!": ["-fno-exceptions"],
          "cflags": ["-fexceptions", "-std=c++17"],
          "ldflags": [
            "-L/usr/local/cuda-12.4/lib64",
            "-lcudart",
            "-lpthread"
          ],
          "libraries": [
            "-L/usr/local/cuda-12.4/lib64",
            "-lcudart", 
            "-lpthread"
          ]
        }]
      ]
    }
  ]
}