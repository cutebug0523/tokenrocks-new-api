package ratio_setting

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/types"
)

var defaultGroupRatio = map[string]float64{
	"default": 1,
	"vip":     1,
	"svip":    1,
}

var groupRatioMap = types.NewRWMap[string, float64]()

var defaultGroupGroupRatio = map[string]map[string]float64{
	"vip": {
		"edit_this": 0.9,
	},
}

var groupGroupRatioMap = types.NewRWMap[string, map[string]float64]()

var defaultGroupSpecialUsableGroup = map[string]map[string]string{}

type GroupRatioSetting struct {
	GroupRatio              *types.RWMap[string, float64]            `json:"group_ratio"`
	GroupGroupRatio         *types.RWMap[string, map[string]float64] `json:"group_group_ratio"`
	GroupSpecialUsableGroup *types.RWMap[string, map[string]string]  `json:"group_special_usable_group"`
	// GroupModelRatio overrides a group's ratio for some models:
	// group -> model name or "prefix*" pattern -> ratio.
	GroupModelRatio *types.RWMap[string, map[string]float64] `json:"group_model_ratio"`
}

var groupRatioSetting GroupRatioSetting

func init() {
	groupSpecialUsableGroup := types.NewRWMap[string, map[string]string]()
	groupSpecialUsableGroup.AddAll(defaultGroupSpecialUsableGroup)

	groupRatioMap.AddAll(defaultGroupRatio)
	groupGroupRatioMap.AddAll(defaultGroupGroupRatio)

	groupRatioSetting = GroupRatioSetting{
		GroupSpecialUsableGroup: groupSpecialUsableGroup,
		GroupRatio:              groupRatioMap,
		GroupGroupRatio:         groupGroupRatioMap,
		GroupModelRatio:         types.NewRWMap[string, map[string]float64](),
	}

	config.GlobalConfig.Register("group_ratio_setting", &groupRatioSetting)
}

func GetGroupRatioSetting() *GroupRatioSetting {
	if groupRatioSetting.GroupSpecialUsableGroup == nil {
		groupRatioSetting.GroupSpecialUsableGroup = types.NewRWMap[string, map[string]string]()
		groupRatioSetting.GroupSpecialUsableGroup.AddAll(defaultGroupSpecialUsableGroup)
	}
	return &groupRatioSetting
}

func GetGroupRatioCopy() map[string]float64 {
	return groupRatioMap.ReadAll()
}

func ContainsGroupRatio(name string) bool {
	_, ok := groupRatioMap.Get(name)
	return ok
}

func GroupRatio2JSONString() string {
	return groupRatioMap.MarshalJSONString()
}

func UpdateGroupRatioByJSONString(jsonStr string) error {
	return types.LoadFromJsonString(groupRatioMap, jsonStr)
}

func GetGroupRatio(name string) float64 {
	ratio, ok := groupRatioMap.Get(name)
	if !ok {
		common.SysLog(common.LogText("group ratio not found: %s", name))
		return 1
	}
	return ratio
}

// GetGroupRatioForModel returns the ratio a model is billed at in a group:
// the group_model_ratio entry for the exact model name, else the entry with
// the longest matching "prefix*" pattern, else the group's GroupRatio.
func GetGroupRatioForModel(group, modelName string) float64 {
	modelRatios := groupRatioSetting.GroupModelRatio
	if modelRatios == nil {
		return GetGroupRatio(group)
	}
	rules, ok := modelRatios.Get(group)
	if !ok {
		return GetGroupRatio(group)
	}
	if ratio, ok := rules[modelName]; ok {
		return ratio
	}
	bestLen, bestRatio := -1, 0.0
	for pattern, ratio := range rules {
		prefix, isPattern := strings.CutSuffix(pattern, "*")
		if !isPattern || len(prefix) <= bestLen || !strings.HasPrefix(modelName, prefix) {
			continue
		}
		bestLen, bestRatio = len(prefix), ratio
	}
	if bestLen >= 0 {
		return bestRatio
	}
	return GetGroupRatio(group)
}

func GetGroupGroupRatio(userGroup, usingGroup string) (float64, bool) {
	gp, ok := groupGroupRatioMap.Get(userGroup)
	if !ok {
		return -1, false
	}
	ratio, ok := gp[usingGroup]
	if !ok {
		return -1, false
	}
	return ratio, true
}

func GroupGroupRatio2JSONString() string {
	return groupGroupRatioMap.MarshalJSONString()
}

func UpdateGroupGroupRatioByJSONString(jsonStr string) error {
	return types.LoadFromJsonString(groupGroupRatioMap, jsonStr)
}

func CheckGroupRatio(jsonStr string) error {
	checkGroupRatio := make(map[string]float64)
	err := json.Unmarshal([]byte(jsonStr), &checkGroupRatio)
	if err != nil {
		return err
	}
	for name, ratio := range checkGroupRatio {
		if ratio < 0 {
			return errors.New("group ratio must be not less than 0: " + name)
		}
	}
	return nil
}

func CheckGroupModelRatio(jsonStr string) error {
	var check map[string]map[string]float64
	if err := common.UnmarshalJsonStr(jsonStr, &check); err != nil {
		return err
	}
	for group, rules := range check {
		for pattern, ratio := range rules {
			if pattern == "" || strings.Contains(strings.TrimSuffix(pattern, "*"), "*") {
				return errors.New("group model ratio pattern must be a model name or end with a single *: " + group + "/" + pattern)
			}
			if ratio < 0 {
				return errors.New("group model ratio must be not less than 0: " + group + "/" + pattern)
			}
		}
	}
	return nil
}
