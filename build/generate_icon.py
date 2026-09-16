import os
from PIL import Image

def generate_ico():
    build_dir = os.path.dirname(os.path.abspath(__file__))
    png_path = os.path.join(build_dir, "icon.png")
    ico_path = os.path.join(build_dir, "icon.ico")

    if not os.path.exists(png_path):
        raise FileNotFoundError(f"Source image not found at {png_path}")

    img = Image.open(png_path).convert("RGBA")

    icon_sizes = [
        (256, 256),
        (128, 128),
        (64, 64),
        (48, 48),
        (32, 32),
        (24, 24),
        (16, 16)
    ]

    img.save(
        ico_path,
        format="ICO",
        sizes=icon_sizes
    )
    print(f"[Pillow] Successfully generated {ico_path} with sizes: {icon_sizes}")

if __name__ == "__main__":
    generate_ico()
