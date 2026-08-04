package api

import (
	"encoding/csv"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MetadataCache holds all data parsed from metadata.csv, keyed by ColumnName.
// It is built once at startup so that every HTTP handler can read from memory
// instead of opening and parsing the file on each request.
type MetadataCache struct {
	Colors            map[string]string
	Details           map[string]string
	VariableTypes     map[string]string
	Inputs            map[string]bool
	TargetInputs      map[string]bool
	TargetRanges      map[string]TargetRange
	CanMap            map[string]bool
	CanGraph          map[string]bool
	AxisLabels        map[string]string
	XAxisLabels       map[string]string
	Units             map[string]string
	ChartTypes        map[string]string
	GroupingVariables map[string]string
	GroupingValues    map[string]string
	Dial0Middle       map[string]bool
	MaxValCurrent     map[string]float64
	MaxValReference   map[string]float64
}

// loadMetadataCache opens metadata.csv once and builds all lookup maps.
// If the file is missing or malformed, empty maps are returned (non-fatal).
func loadMetadataCache(dataDir string) *MetadataCache {
	mc := &MetadataCache{
		Colors:            make(map[string]string),
		Details:           make(map[string]string),
		VariableTypes:     make(map[string]string),
		Inputs:            make(map[string]bool),
		TargetInputs:      make(map[string]bool),
		TargetRanges:      make(map[string]TargetRange),
		CanMap:            make(map[string]bool),
		CanGraph:          make(map[string]bool),
		AxisLabels:        make(map[string]string),
		XAxisLabels:       make(map[string]string),
		Units:             make(map[string]string),
		ChartTypes:        make(map[string]string),
		GroupingVariables: make(map[string]string),
		GroupingValues:    make(map[string]string),
		Dial0Middle:       make(map[string]bool),
		MaxValCurrent:     make(map[string]float64),
		MaxValReference:   make(map[string]float64),
	}

	path := filepath.Join(dataDir, "metadata.csv")
	f, err := os.Open(path)
	if err != nil {
		log.Printf("Info: metadata.csv not found at %s; metadata endpoints will return empty responses (%v)", path, err)
		return mc
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.TrimLeadingSpace = true

	headers, err := r.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata.csv headers: %v", err)
		return mc
	}

	// Locate all column indices in a single pass over the header row.
	idx := make(map[string]int, len(headers))
	for i, h := range headers {
		idx[strings.TrimSpace(h)] = i
	}

	col := func(name string) int {
		if i, ok := idx[name]; ok {
			return i
		}
		return -1
	}

	// Resolve column indices for every field used across all 14 handlers.
	iColumnName := col("ColumnName")
	if iColumnName == -1 {
		log.Printf("Warning: metadata.csv has no ColumnName column; metadata endpoints will return empty responses")
		return mc
	}

	// Color: prefer MappreferredColour, fall back to color.
	iColor := col("MappreferredColour")
	if iColor == -1 {
		iColor = col("color")
	}

	iDetailedName := col("Detailed name")
	if iDetailedName == -1 {
		iDetailedName = col("Detailed_name")
	}

	// VariableType: prefer the more-specific column.
	iVariableType := col("VariableType_highest level of grouping")
	if iVariableType == -1 {
		iVariableType = col("VariableType")
	}

	// CurrentInputsAllowed / legacy userInput
	iInput := col("CurrentInputsAllowed")
	if iInput == -1 {
		iInput = col("userInput")
	}

	// TargetInputsAllowed / legacy targetInput
	iTargetInput := col("TargetInputsAllowed")
	if iTargetInput == -1 {
		iTargetInput = col("targetInput")
	}

	iTargetMin := col("Target_min")
	iTargetMax := col("Target_max")

	// canMap / MapthisYN
	iCanMap := col("canMap")
	if iCanMap == -1 {
		iCanMap = col("MapthisYN")
	}

	// canGraph / graphthisYN
	iCanGraph := col("canGraph")
	if iCanGraph == -1 {
		iCanGraph = col("graphthisYN")
	}

	// axis label
	iAxisLabel := col("axis label")
	if iAxisLabel == -1 {
		iAxisLabel = col("axis_label")
	}

	// x axis
	iXAxis := col("x axis")
	if iXAxis == -1 {
		iXAxis = col("x_axis")
	}
	if iXAxis == -1 {
		iXAxis = col("x-axis")
	}

	iUnits := col("Units")

	// chartType / typeofgraph
	iChartType := col("chartType")
	if iChartType == -1 {
		iChartType = col("typeofgraph")
	}

	iGroupingVariable := col("Grouping variable")
	iGroupingValues := col("GroupingValues")

	iDial0Middle := col("dial_0_middle")

	iMaxValCurrent := col("maxval_curr")
	iMaxValReference := col("maxval_ref")

	get := func(rec []string, i int) string {
		if i < 0 || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	parseBool := func(s string) bool {
		return s == "1" || strings.EqualFold(s, "true")
	}

	parseOptF := func(s string) *float64 {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return nil
		}
		return &v
	}

	rowCount := 0
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		column := get(rec, iColumnName)
		if column == "" {
			continue
		}
		rowCount++

		norm := normalizeMetadataColumn(column)

		// Colors
		if iColor >= 0 {
			if c := normalizeMetadataColor(get(rec, iColor)); c != "" {
				mc.Colors[column] = c
				if norm != "" {
					mc.Colors[norm] = c
				}
			}
		}

		// Details
		if iDetailedName >= 0 {
			if v := get(rec, iDetailedName); v != "" {
				mc.Details[column] = v
				if norm != "" {
					mc.Details[norm] = v
				}
			}
		}

		// VariableTypes
		if iVariableType >= 0 {
			if v := get(rec, iVariableType); v != "" {
				mc.VariableTypes[column] = v
				if norm != "" {
					mc.VariableTypes[norm] = v
				}
			}
		}

		// CurrentInputsAllowed
		if iInput >= 0 {
			if v := get(rec, iInput); v != "" {
				b := parseBool(v)
				mc.Inputs[column] = b
				if norm != "" {
					mc.Inputs[norm] = b
				}
			}
		}

		// TargetInputsAllowed
		if iTargetInput >= 0 {
			if v := get(rec, iTargetInput); v != "" {
				b := parseBool(v)
				mc.TargetInputs[column] = b
				if norm != "" {
					mc.TargetInputs[norm] = b
				}
			}
		}

		// TargetRanges
		var tr TargetRange
		if iTargetMin >= 0 {
			tr.Min = parseOptF(get(rec, iTargetMin))
		}
		if iTargetMax >= 0 {
			tr.Max = parseOptF(get(rec, iTargetMax))
		}
		if tr.Min != nil || tr.Max != nil {
			mc.TargetRanges[column] = tr
		}

		// CanMap
		if iCanMap >= 0 {
			if v := get(rec, iCanMap); v != "" {
				b := parseBool(v)
				mc.CanMap[column] = b
				if norm != "" {
					mc.CanMap[norm] = b
				}
			}
		}

		// CanGraph
		if iCanGraph >= 0 {
			if v := get(rec, iCanGraph); v != "" {
				b := parseBool(v)
				mc.CanGraph[column] = b
				if norm != "" {
					mc.CanGraph[norm] = b
				}
			}
		}

		// AxisLabels
		if iAxisLabel >= 0 {
			if v := get(rec, iAxisLabel); v != "" {
				mc.AxisLabels[column] = v
				if norm != "" {
					mc.AxisLabels[norm] = v
				}
			}
		}

		// XAxisLabels — use Detailed name column
		if iDetailedName >= 0 {
			xv := get(rec, iDetailedName)
			if xv != "" {
				mc.XAxisLabels[column] = xv
				if norm != "" {
					mc.XAxisLabels[norm] = xv
				}
			}
		}

		// Units
		if iUnits >= 0 {
			if v := get(rec, iUnits); v != "" {
				mc.Units[column] = v
				if norm != "" {
					mc.Units[norm] = v
				}
			}
		}

		// ChartTypes
		if iChartType >= 0 {
			if v := get(rec, iChartType); v != "" {
				mc.ChartTypes[column] = v
				if norm != "" {
					mc.ChartTypes[norm] = v
				}
			}
		}

		// GroupingVariables
		if iGroupingVariable >= 0 {
			if v := get(rec, iGroupingVariable); v != "" {
				mc.GroupingVariables[column] = v
				if norm != "" {
					mc.GroupingVariables[norm] = v
				}
			}
		}

		// GroupingValues
		if iGroupingValues >= 0 {
			if v := get(rec, iGroupingValues); v != "" {
				mc.GroupingValues[column] = v
				if norm != "" {
					mc.GroupingValues[norm] = v
				}
			}
		}

		// Dial0Middle: whether the dial gauge should center on zero, with
		// positive values to the right and negative values to the left.
		if iDial0Middle >= 0 {
			if v := get(rec, iDial0Middle); v != "" {
				b := parseBool(v)
				mc.Dial0Middle[column] = b
				if norm != "" {
					mc.Dial0Middle[norm] = b
				}
			}
		}

		// MaxValCurrent / MaxValReference: curated per-scenario ceilings for
		// choropleth color scaling, used instead of scanning every catchment.
		if iMaxValCurrent >= 0 {
			if v := parseOptF(get(rec, iMaxValCurrent)); v != nil {
				mc.MaxValCurrent[column] = *v
				if norm != "" {
					mc.MaxValCurrent[norm] = *v
				}
			}
		}
		if iMaxValReference >= 0 {
			if v := parseOptF(get(rec, iMaxValReference)); v != nil {
				mc.MaxValReference[column] = *v
				if norm != "" {
					mc.MaxValReference[norm] = *v
				}
			}
		}
	}

	log.Printf("Loaded metadata.csv: %d rows", rowCount)
	return mc
}
