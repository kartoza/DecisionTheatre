# Projects

Projects allow you to save and organize multiple catchment analyses. Each project stores its own map state, scenarios, and settings.

## Creating a Project

1. From the Landing Page, click **Projects**
2. Click the **Create New Project** button
3. Fill in the project details:
   - **Thumbnail** (optional) -- drag and drop an image or click to select one. Images are automatically cropped to 16:9 aspect ratio
   - **Title** (required) -- a descriptive name for your project
   - **Description** (optional) -- notes about what this project is analysing
4. Click **Create Project**

You'll be taken directly to the map view where you can begin your analysis.

## Opening a Project

1. From the Landing Page, click **Projects**
2. Click on any project card to open it
3. The map view loads with all your saved settings restored

## Cloning a Project

Cloning creates a copy of an existing project with all its settings:

1. Hover over a project card
2. Click the **Clone** button (copy icon)
3. Modify the title and description as needed
4. Click **Create Project**

This is useful when you want to create variations of an analysis without losing the original.

## Deleting a Project

1. Hover over a project card
2. Click the **Delete** button (trash icon)
3. Confirm the deletion in the dialog

Deleted projects cannot be recovered.

## Project Storage

Projects are stored as JSON files in the `data/projects/` directory. Each project has:

- A unique ID (UUID)
- Creation and update timestamps
- Map state (scenarios, attribute, viewport)

Project thumbnails are stored in `data/images/`.

## Navigating Between Projects

From the map view, you can:

- Click the **Home** icon to return to the Landing Page
- Click the **Projects** icon to go directly to the Projects page
- Click the application title "Landscape Decision Theatre" to return to the Landing Page
