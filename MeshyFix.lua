--[[
	MeshyFix v1.0.0 - Roblox Studio plugin
	Fixes MeshPart meshes imported from Meshy/GLB captures:
	  - applies your imported PNG textures (classic TextureID or PBR SurfaceAppearance)
	  - one-click mesh fixes (DoubleSided, Collision, Render fidelity)
	Workflow:
	  1. Import model.glb + textureN.png via Asset Manager (bulk import).
	  2. Select the imported MeshPart(s), paste the texture asset ID(s), Apply.
	Install:
	  A) Studio: add a Script (e.g. under ServerScriptService), paste this file,
	     right-click it -> "Save as Local Plugin". Done.
	  B) Or copy this file to %LOCALAPPDATA%\Roblox\Plugins and restart Studio.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local Studio = settings().Studio

-- ---------- helpers ----------
local function selectedMeshes()
	local out = {}
	for _, inst in ipairs(Selection:Get()) do
		if inst:IsA("MeshPart") then
			table.insert(out, inst)
		else
			for _, d in ipairs(inst:GetDescendants()) do
				if d:IsA("MeshPart") then
					table.insert(out, d)
				end
			end
		end
	end
	return out
end

-- Accepts raw numbers or rbxassetid://... separated by space/comma/newline.
local function parseIds(text)
	local ids = {}
	for token in string.gmatch(text or "", "[^,%s]+") do
		local num = string.match(token, "(%d+)")
		if num then
			table.insert(ids, "rbxassetid://" .. num)
		end
	end
	return ids
end

local function pickId(ids, i)
	if #ids == 1 then
		return ids[1]
	end
	return ids[((i - 1) % #ids) + 1]
end

local function getOrCreateSA(mesh)
	local sa = mesh:FindFirstChildOfClass("SurfaceAppearance")
	if not sa then
		sa = Instance.new("SurfaceAppearance")
		sa.Name = "MeshyPBR"
		sa.Parent = mesh
	end
	return sa
end

-- ---------- toolbar + widget ----------
local toolbar = plugin:CreateToolbar("MeshyFix")
local toggleButton = toolbar:CreateButton("MeshyFix_Toggle", "Open Meshy Mesh Fix panel", "", "MeshyFix")
toggleButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Float,
	false,
	false,
	340, 400,
	300, 340
)
local widget = plugin:CreateDockWidgetPluginGui("MeshyFix_Widget", widgetInfo)
widget.Title = "Meshy Mesh Fix"

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local root = Instance.new("ScrollingFrame")
root.Name = "Root"
root.Size = UDim2.fromScale(1, 1)
root.AutomaticCanvasSize = Enum.AutomaticSize.Y
root.CanvasSize = UDim2.new(0, 0, 0, 0)
root.ScrollBarThickness = 6
root.BackgroundTransparency = 1
root.Parent = widget

local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 8)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = root

local pad = Instance.new("UIPadding")
pad.PaddingLeft = UDim.new(0, 10)
pad.PaddingRight = UDim.new(0, 10)
pad.PaddingTop = UDim.new(0, 10)
pad.PaddingBottom = UDim.new(0, 10)
pad.Parent = root

local order = 0
local function nextOrder()
	order += 1
	return order
end

local themedTexts = {}
local function trackText(gui)
	table.insert(themedTexts, gui)
	gui.TextColor3 = Studio.Theme:GetColor(Enum.StudioStyleGuideColor.MainText, Enum.StudioStyleGuideModifier.Default)
end
Studio.ThemeChanged:Connect(function()
	local c = Studio.Theme:GetColor(Enum.StudioStyleGuideColor.MainText, Enum.StudioStyleGuideModifier.Default)
	for _, gui in ipairs(themedTexts) do
		gui.TextColor3 = c
	end
end)

local function section(text)
	local l = Instance.new("TextLabel")
	l.LayoutOrder = nextOrder()
	l.Size = UDim2.new(1, 0, 0, 22)
	l.BackgroundTransparency = 1
	l.Font = Enum.Font.GothamBold
	l.TextSize = 14
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = text
	l.Parent = root
	trackText(l)
	return l
end

local function hint(text)
	local l = Instance.new("TextLabel")
	l.LayoutOrder = nextOrder()
	l.Size = UDim2.new(1, 0, 0, 28)
	l.BackgroundTransparency = 1
	l.Font = Enum.Font.Gotham
	l.TextSize = 12
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextWrapped = true
	l.Text = text
	l.Parent = root
	trackText(l)
	return l
end

local function idBox(placeholder)
	local b = Instance.new("TextBox")
	b.LayoutOrder = nextOrder()
	b.Size = UDim2.new(1, 0, 0, 28)
	b.PlaceholderText = placeholder
	b.Text = ""
	b.ClearTextOnFocus = false
	b.Font = Enum.Font.Code
	b.TextSize = 13
	b.Parent = root
	return b
end

local function actionButton(text)
	local b = Instance.new("TextButton")
	b.LayoutOrder = nextOrder()
	b.Size = UDim2.new(1, 0, 0, 30)
	b.Font = Enum.Font.GothamBold
	b.TextSize = 13
	b.Text = text
	b.Parent = root
	return b
end

local countLabel = section("0 meshes selected")
local statusLabel = hint("Select imported MeshPart(s), then apply.")
local function status(msg)
	statusLabel.Text = msg
end

local function refreshCount()
	local n = #selectedMeshes()
	countLabel.Text = (n == 1) and "1 mesh selected" or (tostring(n) .. " meshes selected")
end
Selection.SelectionChanged:Connect(refreshCount)
refreshCount()

local function withUndo(name, fn)
	ChangeHistoryService:SetWaypoint("MeshyFix: before " .. name)
	fn()
	ChangeHistoryService:SetWaypoint("MeshyFix: " .. name)
end

-- ---------- UI: textures ----------
section("1) Textures")
hint("Bulk-import textureN.png via Asset Manager, paste the asset ID(s) below. Several IDs = assigned to selected meshes in order.")

local colorBox = idBox("Color asset ID  (texture0.png import)")
local applyClassicBtn = actionButton("Apply as TextureID")
applyClassicBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart (or a Model containing them).")
		return
	end
	local ids = parseIds(colorBox.Text)
	if #ids == 0 then
		status("Paste the imported color texture asset ID first.")
		return
	end
	withUndo("texture", function()
		for i, m in ipairs(meshes) do
			local sa = m:FindFirstChildOfClass("SurfaceAppearance")
			if sa then
				sa:Destroy()
			end
			m.TextureID = pickId(ids, i)
		end
	end)
	status("Color texture applied to " .. tostring(#meshes) .. " mesh(es). Undo: Ctrl+Z.")
end)

section("PBR (optional)")
hint("Same, but as SurfaceAppearance maps. Leave a field empty to skip it.")

local metalBox = idBox("MetalnessMap asset ID (optional)")
local roughBox = idBox("RoughnessMap asset ID (optional)")
local normalBox = idBox("NormalMap asset ID (optional)")
local applyPBRBtn = actionButton("Apply as SurfaceAppearance")
applyPBRBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart (or a Model containing them).")
		return
	end
	local colorIds = parseIds(colorBox.Text)
	local metalIds = parseIds(metalBox.Text)
	local roughIds = parseIds(roughBox.Text)
	local normalIds = parseIds(normalBox.Text)
	if #colorIds == 0 and #metalIds == 0 and #roughIds == 0 and #normalIds == 0 then
		status("Paste at least one map asset ID.")
		return
	end
	withUndo("PBR", function()
		for i, m in ipairs(meshes) do
			local sa = getOrCreateSA(m)
			if #colorIds > 0 then
				sa.ColorMap = pickId(colorIds, i)
			end
			if #metalIds > 0 then
				sa.MetalnessMap = pickId(metalIds, i)
			end
			if #roughIds > 0 then
				sa.RoughnessMap = pickId(roughIds, i)
			end
			if #normalIds > 0 then
				sa.NormalMap = pickId(normalIds, i)
			end
			m.TextureID = ""
		end
	end)
	status("SurfaceAppearance applied to " .. tostring(#meshes) .. " mesh(es). Undo: Ctrl+Z.")
end)

-- ---------- UI: mesh fixes ----------
section("2) Mesh fixes")
hint("Typical Meshy import issues, applied to every selected mesh.")

local doubleOnBtn = actionButton("DoubleSided ON (fixes invisible faces)")
doubleOnBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart first.")
		return
	end
	withUndo("doublesided", function()
		for _, m in ipairs(meshes) do
			m.DoubleSided = true
		end
	end)
	status("DoubleSided ON for " .. tostring(#meshes) .. " mesh(es).")
end)

local doubleOffBtn = actionButton("DoubleSided OFF")
doubleOffBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart first.")
		return
	end
	withUndo("singlesided", function()
		for _, m in ipairs(meshes) do
			m.DoubleSided = false
		end
	end)
	status("DoubleSided OFF for " .. tostring(#meshes) .. " mesh(es).")
end)

local collisionBtn = actionButton("Collision -> Box (performance)")
collisionBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart first.")
		return
	end
	withUndo("collision", function()
		for _, m in ipairs(meshes) do
			m.CollisionFidelity = Enum.CollisionFidelity.Box
		end
	end)
	status("CollisionFidelity = Box for " .. tostring(#meshes) .. " mesh(es).")
end)

local renderBtn = actionButton("Render -> Performance")
renderBtn.MouseButton1Click:Connect(function()
	local meshes = selectedMeshes()
	if #meshes == 0 then
		status("Select at least one MeshPart first.")
		return
	end
	withUndo("render", function()
		for _, m in ipairs(meshes) do
			m.RenderFidelity = Enum.RenderFidelity.Performance
		end
	end)
	status("RenderFidelity = Performance for " .. tostring(#meshes) .. " mesh(es).")
end)